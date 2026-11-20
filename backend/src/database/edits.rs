use super::{
    CELL_BYTES, SqlClient, SqlError, database_identifier, format_cell, is_clipped, quote_identifier,
};
use crate::{ApiError, AppState, ErrorCode};
use axum::{Json, extract::State, http::StatusCode};
use axum_extra::extract::cookie::CookieJar;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tiberius::{Query, Row};

const EDITABLE_TYPES: &[u8] = &[
    36, // uniqueidentifier
    40, 41, 42, 43, 58, 61, // date, time, datetime2, datetimeoffset, smalldatetime, datetime
    48, 52, 56, 127, 104, // tinyint, smallint, int, bigint, bit
    59, 62, 60, 122, 106, 108, // real, float, money, smallmoney, decimal, numeric
    167, 175, 231, 239, // varchar, char, nvarchar, nchar
];

#[derive(Clone, Deserialize, Eq, Hash, PartialEq, Serialize)]
struct TableName {
    database: String,
    schema: String,
    name: String,
}

impl TableName {
    fn identifier(&self) -> Result<String, ApiError> {
        Ok(format!(
            "{}.{}.{}",
            database_identifier(&self.database)?,
            database_identifier(&self.schema)?,
            database_identifier(&self.name)?
        ))
    }
}

#[derive(Serialize)]
pub(super) struct EditableResult {
    table: TableName,
    object_id: i32,
    key: Vec<KeyColumn>,
    columns: Vec<Option<EditableColumn>>,
}

#[derive(Serialize)]
struct KeyColumn {
    column: String,
    index: usize,
}

#[derive(Serialize)]
struct EditableColumn {
    column: String,
    nullable: bool,
}

struct TableColumn {
    name: String,
    key_order: u8,
    supported: bool,
    writable: bool,
    nullable: bool,
}

struct Table {
    object_id: i32,
    columns: Vec<TableColumn>,
}

impl Table {
    fn primary_key(&self) -> Vec<&TableColumn> {
        let mut key: Vec<_> = self
            .columns
            .iter()
            .filter(|column| column.key_order > 0)
            .collect();
        key.sort_unstable_by_key(|column| column.key_order);
        key
    }
}

async fn table_metadata(
    client: &mut SqlClient,
    name: &TableName,
) -> Result<Option<Table>, SqlError> {
    let Ok(database) = database_identifier(&name.database) else {
        return Ok(None);
    };
    let sql = format!(
        "USE {database};
         SELECT t.object_id, c.name, c.system_type_id, c.is_nullable,
                ISNULL(k.key_ordinal, 0),
                CAST(CASE WHEN c.is_identity = 0 AND c.is_computed = 0 AND
                               c.generated_always_type = 0 AND c.is_hidden = 0 AND
                               HAS_PERMS_BY_NAME(QUOTENAME(s.name) + '.' + QUOTENAME(t.name),
                                   'OBJECT', 'UPDATE', c.name, 'COLUMN') = 1
                          THEN 1 ELSE 0 END AS bit)
         FROM sys.tables AS t
         JOIN sys.schemas AS s ON s.schema_id = t.schema_id
         JOIN sys.columns AS c ON c.object_id = t.object_id
         LEFT JOIN sys.indexes AS i ON i.object_id = t.object_id AND i.is_primary_key = 1
                                  AND i.is_disabled = 0
         LEFT JOIN sys.index_columns AS k ON k.object_id = t.object_id AND k.index_id = i.index_id
                                         AND k.column_id = c.column_id
         WHERE s.name = @P1 AND t.name = @P2 AND t.is_ms_shipped = 0 AND
               t.is_memory_optimized = 0 AND t.temporal_type <> 1"
    );
    let rows = client
        .query(sql, &[&name.schema, &name.name])
        .await?
        .into_first_result()
        .await?;
    let Some(first) = rows.first() else {
        return Ok(None);
    };
    let object_id = first.get::<i32, _>(0).unwrap();
    let columns = rows
        .into_iter()
        .map(|row| {
            let key_order = row.get::<u8, _>(4).unwrap();
            let supported = EDITABLE_TYPES.contains(&row.get::<u8, _>(2).unwrap());
            TableColumn {
                name: row.get::<&str, _>(1).unwrap().to_owned(),
                key_order,
                supported,
                writable: supported && key_order == 0 && row.get::<bool, _>(5).unwrap(),
                nullable: row.get::<bool, _>(3).unwrap(),
            }
        })
        .collect();
    Ok(Some(Table { object_id, columns }))
}

pub(super) async fn describe(
    client: &mut SqlClient,
    database: &str,
    query: &str,
    columns: &[String],
) -> Result<Option<EditableResult>, SqlError> {
    let Ok(database) = database_identifier(database) else {
        return Ok(None);
    };
    let sql = format!(
        "USE {database};
         SELECT name, source_server, source_database, source_schema, source_table, source_column, is_updateable
         FROM sys.dm_exec_describe_first_result_set(@P1, NULL, 1)
         WHERE is_hidden = 0 AND error_number IS NULL
         ORDER BY column_ordinal"
    );
    let rows = client
        .query(sql, &[&query])
        .await?
        .into_first_result()
        .await?;
    if rows.len() != columns.len() {
        return Ok(None);
    }
    let mut origin = None;
    let mut projected = Vec::with_capacity(rows.len());
    for (row, name) in rows.iter().zip(columns) {
        if row.get::<&str, _>(0).unwrap_or_default() != name || row.get::<&str, _>(1).is_some() {
            return Ok(None);
        }
        let (Some(database), Some(schema), Some(table), Some(column)) = (
            row.get::<&str, _>(2),
            row.get::<&str, _>(3),
            row.get::<&str, _>(4),
            row.get::<&str, _>(5),
        ) else {
            projected.push(None);
            continue;
        };
        let source = TableName {
            database: database.into(),
            schema: schema.into(),
            name: table.into(),
        };
        if origin.get_or_insert_with(|| source.clone()) != &source {
            return Ok(None);
        }
        projected.push(Some((column, row.get::<bool, _>(6).unwrap_or(false))));
    }

    let Some(table) = origin else {
        return Ok(None);
    };
    let Some(metadata) = table_metadata(client, &table).await? else {
        return Ok(None);
    };
    let primary_key = metadata.primary_key();
    if primary_key.is_empty() {
        return Ok(None);
    }
    let mut key = Vec::new();
    for column in primary_key {
        let Some(index) = projected
            .iter()
            .position(|entry| entry.is_some_and(|(name, _)| name == column.name))
            .filter(|_| column.supported)
        else {
            return Ok(None);
        };
        key.push(KeyColumn {
            column: column.name.clone(),
            index,
        });
    }
    let columns: Vec<_> = projected
        .into_iter()
        .map(|entry| {
            let (name, true) = entry? else { return None };
            let column = metadata
                .columns
                .iter()
                .find(|column| column.writable && column.name == name)?;
            Some(EditableColumn {
                column: column.name.clone(),
                nullable: column.nullable,
            })
        })
        .collect();
    Ok(columns
        .iter()
        .any(Option::is_some)
        .then_some(EditableResult {
            table,
            object_id: metadata.object_id,
            key,
            columns,
        }))
}

#[derive(Deserialize)]
pub struct SaveRequest {
    rows: Vec<RowEdit>,
}

#[derive(Deserialize)]
struct RowEdit {
    table: TableName,
    object_id: i32,
    key: Vec<KeyValue>,
    changes: Vec<CellChange>,
}

#[derive(Deserialize)]
struct KeyValue {
    column: String,
    value: String,
}

#[derive(Deserialize)]
struct CellChange {
    column: String,
    original: Option<String>,
    value: Option<String>,
}

fn unavailable() -> ApiError {
    ApiError::bad_request(ErrorCode::ResultEditUnavailable)
}

fn conflict() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, ErrorCode::ResultEditConflict)
}

pub async fn save(
    State(state): State<AppState>,
    cookies: CookieJar,
    Json(request): Json<SaveRequest>,
) -> Result<Json<Vec<Vec<Option<String>>>>, ApiError> {
    let session = state.auth.require(&cookies)?;
    if request.rows.is_empty() {
        return Err(unavailable());
    }
    for row in &request.rows {
        row.table.identifier()?;
        if row.changes.is_empty()
            || row.key.is_empty()
            || row.changes.len() + row.key.len() + 2 > Query::MAX_PARAMETERS
        {
            return Err(unavailable());
        }
        if row
            .key
            .iter()
            .map(|key| key.value.as_str())
            .chain(row.changes.iter().flat_map(|cell| {
                [cell.original.as_deref(), cell.value.as_deref()]
                    .into_iter()
                    .flatten()
            }))
            .any(|value| value.len() > CELL_BYTES)
        {
            return Err(ApiError::bad_request(ErrorCode::ResultEditTooLarge));
        }
    }

    let saved = session
        .database
        .run(async |client| {
            client
                .simple_query("BEGIN TRANSACTION")
                .await?
                .into_results()
                .await?;
            let result = save_rows(client, &request.rows).await?;
            let end = if result.is_ok() {
                "COMMIT TRANSACTION"
            } else {
                "ROLLBACK TRANSACTION"
            };
            client.simple_query(end).await?.into_results().await?;
            Ok(result)
        })
        .await??;
    Ok(Json(saved))
}

type SavedRows = Vec<Vec<Option<String>>>;

async fn save_rows(
    client: &mut SqlClient,
    edits: &[RowEdit],
) -> Result<Result<SavedRows, ApiError>, SqlError> {
    let mut tables = HashMap::new();
    let mut saved = Vec::with_capacity(edits.len());
    for edit in edits {
        if let std::collections::hash_map::Entry::Vacant(slot) = tables.entry(&edit.table) {
            let Some(table) = table_metadata(client, &edit.table).await? else {
                return Ok(Err(unavailable()));
            };
            slot.insert(table);
        }
        let table = &tables[&edit.table];
        if table.object_id != edit.object_id {
            return Ok(Err(conflict()));
        }
        let key = table.primary_key();
        if key.len() != edit.key.len()
            || key
                .iter()
                .zip(&edit.key)
                .any(|(column, key)| !column.supported || column.name != key.column)
        {
            return Ok(Err(unavailable()));
        }
        let mut seen = HashSet::new();
        if edit.changes.iter().any(|change| {
            !seen.insert(&change.column)
                || !table.columns.iter().any(|column| {
                    column.writable
                        && column.name == change.column
                        && (column.nullable || change.value.is_some())
                })
        }) {
            return Ok(Err(unavailable()));
        }
        match save_row(client, edit).await? {
            Ok(values) => saved.push(values),
            Err(problem) => return Ok(Err(problem)),
        }
    }
    Ok(Ok(saved))
}

async fn save_row(
    client: &mut SqlClient,
    edit: &RowEdit,
) -> Result<Result<Vec<Option<String>>, ApiError>, SqlError> {
    let table = edit
        .table
        .identifier()
        .unwrap_or_else(|_| unreachable!("validated table name"));
    let key_columns = edit
        .key
        .iter()
        .map(|key| quote_identifier(&key.column))
        .collect::<Vec<_>>();
    let columns = edit
        .changes
        .iter()
        .map(|cell| quote_identifier(&cell.column))
        .collect::<Vec<_>>();
    let predicate = key_columns
        .iter()
        .enumerate()
        .map(|(i, column)| format!("{column} = @P{}", i + 1))
        .collect::<Vec<_>>()
        .join(" AND ");
    let table_param = edit.key.len() + 1;
    let object_param = table_param + 1;
    let select = format!(
        "SET DATEFORMAT ymd;
         SELECT {}, {} FROM {table} WITH (UPDLOCK, HOLDLOCK)
         WHERE {predicate} AND OBJECT_ID(@P{table_param}, N'U') = @P{object_param}",
        key_columns.join(", "),
        columns.join(", ")
    );
    let mut lookup = Query::new(&select);
    lookup.bind_iter(edit.key.iter().map(|key| key.value.as_str()));
    lookup.bind(table.as_str());
    lookup.bind(edit.object_id);

    let mut rows = lookup.query(client).await?.into_first_result().await?;
    if rows.len() != 1 {
        return Ok(Err(conflict()));
    }
    let Some(values) = full_values(rows.pop().unwrap())? else {
        return Ok(Err(conflict()));
    };
    let (key, current) = values.split_at(edit.key.len());
    if key
        .iter()
        .zip(&edit.key)
        .any(|(value, key)| value.as_deref() != Some(&key.value))
        || current
            .iter()
            .zip(&edit.changes)
            .any(|(value, edit)| value != &edit.original)
    {
        return Ok(Err(conflict()));
    }

    let assignments = columns
        .iter()
        .enumerate()
        .map(|(i, column)| format!("{column} = @P{}", i + object_param + 1))
        .collect::<Vec<_>>();
    let sql = format!(
        "SET DATEFORMAT ymd;
         UPDATE {table} SET {} WHERE {predicate} AND OBJECT_ID(@P{table_param}, N'U') = @P{object_param};
         IF @@ROWCOUNT <> 1 THROW 50001, 'The result row could not be updated.', 1;
         {select}",
        assignments.join(", ")
    );
    let mut update = Query::new(sql);
    update.bind_iter(edit.key.iter().map(|key| key.value.as_str()));
    update.bind(table.as_str());
    update.bind(edit.object_id);
    update.bind_iter(edit.changes.iter().map(|cell| cell.value.as_deref()));
    let mut results = update.query(client).await?.into_results().await?;
    let Some(rows) = results.pop() else {
        return Ok(Err(conflict()));
    };
    if rows.len() != 1 {
        return Ok(Err(conflict()));
    }
    let Some(mut values) = full_values(rows.into_iter().next().unwrap())? else {
        return Ok(Err(ApiError::bad_request(ErrorCode::ResultEditTooLarge)));
    };
    if !values
        .iter()
        .zip(&edit.key)
        .all(|(value, key)| value.as_deref() == Some(&key.value))
    {
        return Ok(Err(conflict()));
    }
    Ok(Ok(values.split_off(edit.key.len())))
}

fn full_values(row: Row) -> Result<Option<Vec<Option<String>>>, SqlError> {
    let mut cells = Vec::new();
    for cell in row {
        if is_clipped(&cell) {
            return Ok(None);
        }
        cells.push(format_cell(cell)?);
    }
    Ok(Some(cells))
}
