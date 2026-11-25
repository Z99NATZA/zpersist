use super::database_identifier;
use crate::{ApiError, ErrorCode};
use serde_json::json;
use sqlparser::{
    ast::{Query, Select, SetExpr, Statement, TableFactor, Use, Visit, Visitor},
    dialect::MsSqlDialect,
    parser::{Parser, ParserOptions},
};
use std::ops::ControlFlow;

const SQL_BYTES: usize = 24 * 1024;

pub struct Selection {
    pub batch: String,
    pub editable_queries: Vec<Option<(String, String)>>,
}

pub fn prepare(database: &str, sql: &str) -> Result<Selection, ApiError> {
    let identifier = database_identifier(database)?;
    if sql.len() > SQL_BYTES {
        return Err(ApiError::bad_request(ErrorCode::SqlTooLarge)
            .with_params(json!({ "limit": SQL_BYTES / 1024 })));
    }

    let dialect = MsSqlDialect {};
    let statements = Parser::new(&dialect)
        .with_options(ParserOptions {
            require_semicolon_stmt_delimiter: false,
            ..ParserOptions::default()
        })
        .try_with_sql(sql)
        .and_then(|mut parser| parser.parse_statements())
        .map_err(|error| {
            ApiError::bad_request(ErrorCode::SqlInvalid).with_detail(error.to_string())
        })?;

    let mut validation = BatchValidation::default();
    if statements.visit(&mut validation).is_break() {
        return Err(ApiError::bad_request(ErrorCode::UnsupportedStatement));
    }
    if !statements
        .iter()
        .any(|statement| !matches!(statement, Statement::Use(_)))
    {
        return Err(ApiError::bad_request(ErrorCode::NoStatement));
    }

    // OUTPUT and triggers can return result sets that do not belong to a SELECT.
    let editable_queries = if validation.writes_data {
        Vec::new()
    } else {
        let mut context = database;
        let mut queries = Vec::new();
        for statement in &statements {
            match statement {
                Statement::Use(Use::Object(name)) => context = &name.0[0].as_ident().unwrap().value,
                Statement::Query(query) => {
                    queries.push(editable(query).then(|| (context.to_owned(), query.to_string())));
                }
                _ => {}
            }
        }
        queries
    };

    // The first USE sets the context on every checkout, even after an override on this connection.
    Ok(Selection {
        batch: format!("USE {identifier};\n{sql}"),
        editable_queries,
    })
}

fn editable(query: &Query) -> bool {
    let SetExpr::Select(select) = query.body.as_ref() else {
        return false;
    };
    query.with.is_none()
        && query.for_clause.is_none()
        && select.distinct.is_none()
        && matches!(
            select.from.as_slice(),
            [table] if table.joins.is_empty()
                && matches!(&table.relation, TableFactor::Table { name, args: None, version: None, .. } if name.0.len() <= 3)
        )
}

#[derive(Default)]
struct BatchValidation {
    writes_data: bool,
}

impl Visitor for BatchValidation {
    type Break = ();

    fn pre_visit_statement(&mut self, statement: &Statement) -> ControlFlow<()> {
        match statement {
            Statement::Insert(_) | Statement::Update(_) | Statement::Delete(_) => {
                self.writes_data = true;
                ControlFlow::Continue(())
            }
            Statement::Query(_) => ControlFlow::Continue(()),
            Statement::Use(Use::Object(name)) if matches!(name.0.as_slice(), [part] if part.as_ident().is_some()) => {
                ControlFlow::Continue(())
            }
            _ => ControlFlow::Break(()),
        }
    }

    fn pre_visit_select(&mut self, select: &Select) -> ControlFlow<()> {
        if select.into.is_some() {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supports_context_override_and_multiple_selects() {
        let sql = "SELECT DB_NAME(); USE [other db]\nSELECT TOP (1) * FROM dbo.[items];";
        let selection = prepare("a]b", sql).ok().expect("valid SQL");
        assert_eq!(selection.batch, format!("USE [a]]b];\n{sql}"));
        assert_eq!(selection.editable_queries.len(), 2);
        assert!(selection.editable_queries[0].is_none());
        assert_eq!(
            selection.editable_queries[1].as_ref().unwrap().0,
            "other db"
        );
        assert!(
            prepare(
                "master",
                "WITH cte AS (SELECT 1 AS a) SELECT a FROM cte UNION ALL SELECT 2;"
            )
            .is_ok()
        );
    }

    #[test]
    fn supports_data_changes_with_or_without_result_sets() {
        for sql in [
            "INSERT INTO dbo.items (id, name) VALUES (1, N'ไทย'), (2, N'b');",
            "INSERT dbo.items (id, name) SELECT id, name FROM dbo.source;",
            "INSERT INTO dbo.items DEFAULT VALUES;",
            "UPDATE dbo.items SET name = N'new' WHERE id = 1;",
            "DELETE FROM dbo.items WHERE id = 2;",
            "WITH c AS (SELECT * FROM dbo.items) DELETE FROM c;",
            "WITH c AS (SELECT * FROM dbo.items) UPDATE c SET name = N'new';",
            "WITH c AS (SELECT id FROM dbo.source) INSERT INTO dbo.items (id) SELECT id FROM c;",
            "USE [other db]\nINSERT INTO dbo.items (id) OUTPUT inserted.id VALUES (3); SELECT * FROM dbo.items;",
            "UPDATE dbo.items SET name = N'new' OUTPUT inserted.id WHERE id = 1;",
            "DELETE FROM dbo.items OUTPUT deleted.id WHERE id = 2;",
        ] {
            let selection = prepare("master", sql)
                .ok()
                .unwrap_or_else(|| panic!("{sql}"));
            assert_eq!(selection.batch, format!("USE [master];\n{sql}"));
            assert!(selection.editable_queries.is_empty(), "{sql}");
        }
    }

    #[test]
    fn rejects_other_statements_and_select_into() {
        for sql in [
            "SELECT 1; DROP TABLE dbo.items;",
            "SELECT 1; EXEC sp_who;",
            "SELECT 1 INTO #new_table;",
            "UPDATE dbo.items SET id = 1; TRUNCATE TABLE dbo.items;",
            "DELETE FROM dbo.items; SET NOCOUNT ON;",
            "USE master;",
            "-- only a comment",
        ] {
            assert!(prepare("master", sql).is_err(), "{sql}");
        }
    }
}
