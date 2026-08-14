use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
use tauri::Manager;

const MAX_LIBRARY_PDF_BYTES: usize = 100 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct LibrarySaveRequest {
    pub file_name: String,
    pub source_url: String,
    pub part_number: String,
    pub manufacturer: String,
    pub page_count: u32,
    pub data_base64: String,
    pub blocks_json: String,
    pub search_lines_json: String,
    pub page_sizes_json: String,
    pub questions_json: String,
    pub messages_json: String,
}

#[derive(Debug, Deserialize)]
pub struct LibraryUpdateRequest {
    pub id: i64,
    pub part_number: String,
    pub manufacturer: String,
    pub questions_json: String,
    pub messages_json: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LibraryDocument {
    pub id: i64,
    pub hash: String,
    pub file_name: String,
    pub source_url: String,
    pub part_number: String,
    pub manufacturer: String,
    pub page_count: u32,
    pub file_size: u64,
    pub created_at: String,
    pub updated_at: String,
    pub last_opened_at: String,
}

#[derive(Debug, Serialize)]
pub struct LibraryLoadedDocument {
    #[serde(flatten)]
    pub document: LibraryDocument,
    pub data_base64: String,
    pub blocks_json: String,
    pub search_lines_json: String,
    pub page_sizes_json: String,
    pub questions_json: String,
    pub messages_json: String,
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法读取应用数据目录：{error}"))?;
    fs::create_dir_all(&path).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    Ok(path)
}

fn library_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = app_data_dir(app)?.join("library");
    fs::create_dir_all(&path).map_err(|error| format!("无法创建文档库目录：{error}"))?;
    Ok(path)
}

fn open_database(app: &tauri::AppHandle) -> Result<Connection, String> {
    let connection = Connection::open(app_data_dir(app)?.join("specpilot.db"))
        .map_err(|error| format!("无法打开文档库数据库：{error}"))?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS documents (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               hash TEXT NOT NULL UNIQUE,
               file_name TEXT NOT NULL,
               source_url TEXT NOT NULL DEFAULT '',
               part_number TEXT NOT NULL DEFAULT '',
               manufacturer TEXT NOT NULL DEFAULT '',
               page_count INTEGER NOT NULL DEFAULT 0,
               file_size INTEGER NOT NULL DEFAULT 0,
               blocks_json TEXT NOT NULL DEFAULT '[]',
               search_lines_json TEXT NOT NULL DEFAULT '[]',
               page_sizes_json TEXT NOT NULL DEFAULT '[]',
               questions_json TEXT NOT NULL DEFAULT '[]',
               messages_json TEXT NOT NULL DEFAULT '[]',
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               last_opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             CREATE INDEX IF NOT EXISTS idx_documents_part_number ON documents(part_number);
             CREATE INDEX IF NOT EXISTS idx_documents_last_opened ON documents(last_opened_at DESC);",
        )
        .map_err(|error| format!("无法初始化文档库数据库：{error}"))?;
    Ok(connection)
}

fn row_to_document(row: &Row<'_>) -> rusqlite::Result<LibraryDocument> {
    Ok(LibraryDocument {
        id: row.get(0)?,
        hash: row.get(1)?,
        file_name: row.get(2)?,
        source_url: row.get(3)?,
        part_number: row.get(4)?,
        manufacturer: row.get(5)?,
        page_count: row.get::<_, i64>(6)?.max(0) as u32,
        file_size: row.get::<_, i64>(7)?.max(0) as u64,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        last_opened_at: row.get(10)?,
    })
}

pub fn save_document(
    app: &tauri::AppHandle,
    request: LibrarySaveRequest,
) -> Result<LibraryDocument, String> {
    let bytes = BASE64
        .decode(request.data_base64.as_bytes())
        .map_err(|_| "保存到文档库的 PDF 数据无效".to_string())?;
    if bytes.len() > MAX_LIBRARY_PDF_BYTES {
        return Err("PDF 超过文档库 100 MB 上限".into());
    }
    if !bytes.starts_with(b"%PDF-") {
        return Err("只能把有效 PDF 保存到文档库".into());
    }

    let hash = format!("{:x}", Sha256::digest(&bytes));
    let stored_name = format!("{hash}.pdf");
    let stored_path = library_dir(app)?.join(&stored_name);
    if !stored_path.exists() {
        fs::write(&stored_path, &bytes).map_err(|error| format!("无法保存 PDF：{error}"))?;
    }

    let connection = open_database(app)?;
    let existing_id = connection
        .query_row(
            "SELECT id FROM documents WHERE hash = ?1",
            params![hash],
            |row| row.get::<_, i64>(0),
        )
        .ok();
    let id = if let Some(id) = existing_id {
        connection
            .execute(
                "UPDATE documents SET
                   file_name=?2, source_url=CASE WHEN ?3='' THEN source_url ELSE ?3 END,
                   part_number=CASE WHEN ?4='' THEN part_number ELSE ?4 END,
                   manufacturer=CASE WHEN ?5='' THEN manufacturer ELSE ?5 END,
                   page_count=?6, file_size=?7, blocks_json=?8, search_lines_json=?9,
                   page_sizes_json=?10, questions_json=?11, messages_json=?12,
                   updated_at=CURRENT_TIMESTAMP, last_opened_at=CURRENT_TIMESTAMP
                 WHERE id=?1",
                params![
                    id,
                    request.file_name,
                    request.source_url,
                    request.part_number,
                    request.manufacturer,
                    request.page_count,
                    bytes.len() as i64,
                    request.blocks_json,
                    request.search_lines_json,
                    request.page_sizes_json,
                    request.questions_json,
                    request.messages_json,
                ],
            )
            .map_err(|error| format!("无法更新文档库记录：{error}"))?;
        id
    } else {
        connection
            .execute(
                "INSERT INTO documents (
                   hash, file_name, source_url, part_number, manufacturer, page_count, file_size,
                   blocks_json, search_lines_json, page_sizes_json, questions_json, messages_json
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                params![
                    hash,
                    request.file_name,
                    request.source_url,
                    request.part_number,
                    request.manufacturer,
                    request.page_count,
                    bytes.len() as i64,
                    request.blocks_json,
                    request.search_lines_json,
                    request.page_sizes_json,
                    request.questions_json,
                    request.messages_json,
                ],
            )
            .map_err(|error| format!("无法写入文档库记录：{error}"))?;
        connection.last_insert_rowid()
    };
    get_document_metadata(&connection, id)
}

fn get_document_metadata(connection: &Connection, id: i64) -> Result<LibraryDocument, String> {
    connection
        .query_row(
            "SELECT id,hash,file_name,source_url,part_number,manufacturer,page_count,file_size,
                    created_at,updated_at,last_opened_at FROM documents WHERE id=?1",
            params![id],
            row_to_document,
        )
        .map_err(|error| format!("无法读取文档库记录：{error}"))
}

pub fn list_documents(
    app: &tauri::AppHandle,
    query: &str,
) -> Result<Vec<LibraryDocument>, String> {
    let connection = open_database(app)?;
    let query = query.trim();
    let columns = "id,hash,file_name,source_url,part_number,manufacturer,page_count,file_size,
                   created_at,updated_at,last_opened_at";
    let mut documents = Vec::new();
    if query.is_empty() {
        let mut statement = connection
            .prepare(&format!("SELECT {columns} FROM documents ORDER BY last_opened_at DESC, id DESC"))
            .map_err(|error| format!("无法查询文档库：{error}"))?;
        let rows = statement
            .query_map([], row_to_document)
            .map_err(|error| format!("无法读取文档库：{error}"))?;
        for row in rows {
            documents.push(row.map_err(|error| format!("文档库记录损坏：{error}"))?);
        }
    } else {
        let pattern = format!("%{query}%");
        let mut statement = connection
            .prepare(&format!(
                "SELECT {columns} FROM documents
                 WHERE file_name LIKE ?1 OR part_number LIKE ?1 OR manufacturer LIKE ?1
                 ORDER BY last_opened_at DESC, id DESC"
            ))
            .map_err(|error| format!("无法查询文档库：{error}"))?;
        let rows = statement
            .query_map(params![pattern], row_to_document)
            .map_err(|error| format!("无法读取文档库：{error}"))?;
        for row in rows {
            documents.push(row.map_err(|error| format!("文档库记录损坏：{error}"))?);
        }
    }
    Ok(documents)
}

pub fn load_document(
    app: &tauri::AppHandle,
    id: i64,
) -> Result<LibraryLoadedDocument, String> {
    let connection = open_database(app)?;
    connection
        .execute(
            "UPDATE documents SET last_opened_at=CURRENT_TIMESTAMP WHERE id=?1",
            params![id],
        )
        .map_err(|error| format!("无法更新最近打开时间：{error}"))?;
    let document = get_document_metadata(&connection, id)?;
    let stored_path = library_dir(app)?.join(format!("{}.pdf", document.hash));
    let bytes = fs::read(&stored_path).map_err(|error| format!("文档库中的 PDF 已丢失：{error}"))?;
    let payload = connection
        .query_row(
            "SELECT blocks_json,search_lines_json,page_sizes_json,questions_json,messages_json
             FROM documents WHERE id=?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .map_err(|error| format!("无法读取缓存分析：{error}"))?;
    Ok(LibraryLoadedDocument {
        document,
        data_base64: BASE64.encode(bytes),
        blocks_json: payload.0,
        search_lines_json: payload.1,
        page_sizes_json: payload.2,
        questions_json: payload.3,
        messages_json: payload.4,
    })
}

pub fn update_document(
    app: &tauri::AppHandle,
    request: LibraryUpdateRequest,
) -> Result<(), String> {
    let connection = open_database(app)?;
    connection
        .execute(
            "UPDATE documents SET
               part_number=CASE WHEN ?2='' THEN part_number ELSE ?2 END,
               manufacturer=CASE WHEN ?3='' THEN manufacturer ELSE ?3 END,
               questions_json=?4, messages_json=?5, updated_at=CURRENT_TIMESTAMP
             WHERE id=?1",
            params![
                request.id,
                request.part_number,
                request.manufacturer,
                request.questions_json,
                request.messages_json
            ],
        )
        .map_err(|error| format!("无法保存分析结果：{error}"))?;
    Ok(())
}

pub fn delete_document(app: &tauri::AppHandle, id: i64) -> Result<bool, String> {
    let connection = open_database(app)?;
    let hash = connection
        .query_row(
            "SELECT hash FROM documents WHERE id=?1",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("找不到要删除的文档：{error}"))?;
    let affected = connection
        .execute("DELETE FROM documents WHERE id=?1", params![id])
        .map_err(|error| format!("无法删除文档库记录：{error}"))?;
    let stored_path = library_dir(app)?.join(format!("{hash}.pdf"));
    if stored_path.exists() {
        fs::remove_file(stored_path).map_err(|error| format!("记录已删除，但 PDF 文件删除失败：{error}"))?;
    }
    Ok(affected > 0)
}

