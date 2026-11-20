use super::database_identifier;
use crate::{ApiError, ErrorCode};
use serde_json::json;
use sqlparser::{
    ast::{Select, Statement, Use, Visit, Visitor},
    dialect::MsSqlDialect,
    parser::{Parser, ParserOptions},
};
use std::ops::ControlFlow;

const SQL_BYTES: usize = 24 * 1024;

pub fn prepare(database: &str, sql: &str) -> Result<String, ApiError> {
    let database = database_identifier(database)?;
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

    if statements.visit(&mut ReadOnly).is_break() {
        return Err(ApiError::bad_request(ErrorCode::ReadOnly));
    }
    if !statements
        .iter()
        .any(|statement| matches!(statement, Statement::Query(_)))
    {
        return Err(ApiError::bad_request(ErrorCode::NoSelect));
    }

    // The first USE sets the context on every checkout, even after an override on this connection.
    Ok(format!("USE {database};\n{sql}"))
}

struct ReadOnly;

impl Visitor for ReadOnly {
    type Break = ();

    fn pre_visit_statement(&mut self, statement: &Statement) -> ControlFlow<()> {
        match statement {
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
        assert_eq!(
            prepare("a]b", sql).ok(),
            Some(format!("USE [a]]b];\n{sql}"))
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
    fn rejects_mutations_in_the_batch() {
        for sql in [
            "SELECT 1; DROP TABLE dbo.items;",
            "SELECT 1; EXEC sp_who;",
            "SELECT 1 INTO #new_table;",
            "WITH c AS (SELECT * FROM dbo.items) DELETE FROM c;",
            "USE master;",
        ] {
            assert!(prepare("master", sql).is_err(), "{sql}");
        }
    }
}
