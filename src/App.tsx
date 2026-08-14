import { FormEvent, RefObject, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { BoundingBox, DocumentSource, TextBlock, ViewerController } from "./types";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

type PdfDocument = Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>;
type PdfPage = Awaited<ReturnType<PdfDocument["getPage"]>>;
type PageSize = { width: number; height: number };
type Highlight = { page: number; bbox: BoundingBox } | null;
type ChatMessage = { role: "user" | "assistant"; text: string; sources?: DocumentSource[]; error?: boolean };
type SideMode = "thumbnails" | "search";
type RightMode = "assistant" | "finder" | "library" | "manual";
type ModelMessage = { role: "system" | "user" | "assistant"; content: string };
type ProviderId = "deepseek" | "openai" | "openrouter" | "siliconflow" | "custom";
type SearchEngineId = "bing" | "google" | "duckduckgo" | "baidu";
type ProviderPreset = { id: ProviderId; name: string; baseUrl: string; model: string; models: { label: string; value: string }[] };
type DownloadedPdf = { file_name: string; data_base64: string };
type NetworkTestResult = { reachable: boolean; status?: number; message: string };
type StoredAppSettings = { provider: ProviderId; base_url: string; model: string; proxy_url: string; search_engine: SearchEngineId; remember_api_keys: boolean };
type LibraryDocument = { id: number; hash: string; file_name: string; source_url: string; part_number: string; manufacturer: string; page_count: number; file_size: number; created_at: string; updated_at: string; last_opened_at: string };
type LibraryLoadedDocument = LibraryDocument & { data_base64: string; blocks_json: string; search_lines_json: string; page_sizes_json: string; questions_json: string; messages_json: string };
type ManualCandidate = { title: string; url: string; host: string; snippet: string; score: number; official: boolean; verified_pdf: boolean; reason: string };
type ManualSearchPlan = { part_number: string; manufacturer: string; official_domains: string[]; queries: string[] };
type SerializedLibraryPayload = { data_base64: string; blocks_json: string; search_lines_json: string; page_sizes_json: string; questions_json: string };
type SearchPart = TextBlock & { start: number; end: number };
type SearchLine = TextBlock & { parts: SearchPart[] };
type RestoredLibraryPayload = { buffer: ArrayBuffer; blocks: TextBlock[]; searchLines: SearchLine[]; pageSizes: PageSize[]; questions: string[]; messages: ChatMessage[] };
type OpenDocumentOptions = { sourceUrl?: string; partNumber?: string; manufacturer?: string; cached?: LibraryLoadedDocument; restored?: RestoredLibraryPayload; skipSave?: boolean };
type ManualBounds = { x: number; y: number; width: number; height: number };

const PROVIDERS: ProviderPreset[] = [
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", models: [{ label: "V4 Flash", value: "deepseek-v4-flash" }, { label: "V4 Pro", value: "deepseek-v4-pro" }] },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "chat-latest", models: [{ label: "Chat Latest", value: "chat-latest" }, { label: "GPT-5.6", value: "gpt-5.6" }] },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openrouter/auto", models: [{ label: "自动路由", value: "openrouter/auto" }] },
  { id: "siliconflow", name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "Pro/zai-org/GLM-4.7", models: [{ label: "GLM-4.7", value: "Pro/zai-org/GLM-4.7" }] },
  { id: "custom", name: "自定义", baseUrl: "", model: "", models: [] },
];

const SEARCH_ENGINES: { id: SearchEngineId; name: string; home: string }[] = [
  { id: "bing", name: "Bing", home: "https://www.bing.com" },
  { id: "baidu", name: "百度", home: "https://www.baidu.com" },
  { id: "google", name: "Google", home: "https://www.google.com" },
  { id: "duckduckgo", name: "DuckDuckGo", home: "https://duckduckgo.com" },
];

const yieldToBrowser = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));
const runPersistenceWorker = <T,>(message: unknown, transfer: Transferable[] = []) => new Promise<T>((resolve, reject) => {
  const worker = new Worker(new URL("./persistence.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<T>) => { worker.terminate(); resolve(event.data); };
  worker.onerror = () => { worker.terminate(); reject(new Error("后台文档缓存处理失败")); };
  worker.postMessage(message, transfer);
});
const serializeLibraryPayload = (bytes: Uint8Array, blocks: TextBlock[], searchLines: SearchLine[], pageSizes: PageSize[], questions: string[]) => {
  const buffer = bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer as ArrayBuffer;
  return runPersistenceWorker<SerializedLibraryPayload>({ action: "serialize", buffer, blocks, searchLines, pageSizes, questions }, [buffer]);
};
const decodePdfPayload = (dataBase64: string) => runPersistenceWorker<{ buffer: ArrayBuffer }>({ action: "decode", dataBase64 });
const restoreLibraryPayload = (cached: LibraryLoadedDocument) => runPersistenceWorker<RestoredLibraryPayload>({
  action: "restore",
  dataBase64: cached.data_base64,
  blocksJson: cached.blocks_json,
  searchLinesJson: cached.search_lines_json,
  pageSizesJson: cached.page_sizes_json,
  questionsJson: cached.questions_json,
  messagesJson: cached.messages_json,
});
const parseModelObject = <T,>(value: string): T => {
  const cleaned = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回 JSON 对象");
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
};
const inferPartNumber = (fileName: string, blocks: TextBlock[]) => {
  const source = `${fileName} ${blocks.slice(0, 8).map((block) => block.text).join(" ")}`;
  return source.match(/\b[A-Z]{1,6}[A-Z0-9]*\d[A-Z0-9-]{2,20}\b/i)?.[0]?.toUpperCase() ?? "";
};
const formatFileSize = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const tokenize = (value: string) => value.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*|[\u4e00-\u9fff]{2,}/g) ?? [];
const unionBoxes = (boxes: BoundingBox[]): BoundingBox => {
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x, y, width: right - x, height: bottom - y };
};
const rotateBox = (box: BoundingBox, rotation: number): BoundingBox => {
  const normalized = ((rotation % 360) + 360) % 360;
  if (normalized === 90) return { x: 1 - box.y - box.height, y: box.x, width: box.height, height: box.width };
  if (normalized === 180) return { x: 1 - box.x - box.width, y: 1 - box.y - box.height, width: box.width, height: box.height };
  if (normalized === 270) return { x: box.y, y: 1 - box.x - box.width, width: box.height, height: box.width };
  return box;
};

function searchDocument(blocks: TextBlock[], queries: string[], limit = 12): DocumentSource[] {
  const plans = queries.map((query) => ({ phrase: query.toLowerCase().trim(), terms: [...new Set(tokenize(query))] })).filter((plan) => plan.terms.length);
  if (!plans.length) return [];
  const results: DocumentSource[] = [];
  for (const block of blocks) {
    const text = block.text.toLowerCase();
    let bestScore = 0;
    let matchingPlans = 0;
    for (const plan of plans) {
      const hits = plan.terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
      const score = (hits + (plan.phrase && text.includes(plan.phrase) ? 2 : 0)) / Math.max(plan.terms.length, 1);
      if (score > 0) matchingPlans++;
      bestScore = Math.max(bestScore, score);
    }
    if (bestScore > 0) results.push({ ...block, score: bestScore + matchingPlans * 0.02 });
  }
  return results.sort((left, right) => (right.score ?? 0) - (left.score ?? 0)).slice(0, limit);
}

function buildSearchLines(items: TextBlock[]): SearchLine[] {
  const lines: SearchLine[] = [];
  let row: TextBlock[] = [];
  const flush = () => {
    if (!row.length) return;
    let text = "";
    const parts: SearchPart[] = [];
    for (const item of row) {
      const separator = text && !/\s$/.test(text) && !/^\s/.test(item.text) ? " " : "";
      text += separator;
      const start = text.length;
      text += item.text;
      parts.push({ ...item, start, end: text.length });
    }
    lines.push({ page: row[0].page, text, bbox: unionBoxes(row.map((item) => item.bbox)), parts });
    row = [];
  };
  for (const item of items) {
    const previous = row[row.length - 1];
    if (previous) {
      const previousCenter = previous.bbox.y + previous.bbox.height / 2;
      const itemCenter = item.bbox.y + item.bbox.height / 2;
      const sameRow = Math.abs(previousCenter - itemCenter) <= Math.max(previous.bbox.height, item.bbox.height) * 0.7;
      const stillMovingRight = item.bbox.x + 0.012 >= previous.bbox.x;
      if (!sameRow || !stillMovingRight) flush();
    }
    row.push(item);
  }
  flush();
  return lines;
}

function findDocument(lines: SearchLine[], query: string, limit = 300): DocumentSource[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const results: DocumentSource[] = [];
  for (const line of lines) {
    const haystack = line.text.toLocaleLowerCase();
    let offset = 0;
    while (offset <= haystack.length - needle.length && results.length < limit) {
      const matchStart = haystack.indexOf(needle, offset);
      if (matchStart < 0) break;
      const matchEnd = matchStart + needle.length;
      const boxes: BoundingBox[] = [];
      for (const part of line.parts) {
        const overlapStart = Math.max(matchStart, part.start);
        const overlapEnd = Math.min(matchEnd, part.end);
        if (overlapEnd <= overlapStart || !part.text.length) continue;
        const localStart = (overlapStart - part.start) / part.text.length;
        const localEnd = (overlapEnd - part.start) / part.text.length;
        boxes.push({
          x: part.bbox.x + part.bbox.width * localStart,
          y: part.bbox.y,
          width: Math.max(part.bbox.width * (localEnd - localStart), 0.003),
          height: part.bbox.height,
        });
      }
      if (boxes.length) results.push({ page: line.page, text: line.text, bbox: unionBoxes(boxes), score: 1 });
      offset = matchStart + Math.max(needle.length, 1);
    }
    if (results.length >= limit) break;
  }
  return results;
}

function buildLocalQuestions(blocks: TextBlock[], fileName: string): string[] {
  const title = fileName.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim() || "这份文档";
  const text = blocks.slice(0, 80).map((block) => block.text).join(" ");
  const ignored = new Set(["THE", "AND", "FOR", "WITH", "FROM", "THIS", "THAT", "PAGE", "PDF", "REV", "TABLE", "FIGURE", "NOTE", "SPECIFICATION"]);
  const counts = new Map<string, number>();
  for (const token of text.match(/\b[A-Z][A-Z0-9_/-]{2,18}\b/g) ?? []) {
    if (ignored.has(token) || /^\d+$/.test(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const terms = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([term]) => term).slice(0, 3);
  const questions = [`${title} 的主要功能、适用场景和关键限制是什么？`];
  if (terms[0]) questions.push(`${terms[0]} 的关键参数、工作条件和限制是什么？`);
  else questions.push("文档中最重要的技术参数和限制有哪些？");
  if (terms[1]) questions.push(`如何配置和使用 ${terms[1]}，相关章节或寄存器在哪里？`);
  else questions.push("文档推荐的配置流程和注意事项是什么？");
  if (terms[2]) questions.push(`${terms[2]} 的时序、接口或典型应用在哪里说明？`);
  return questions.slice(0, 4);
}

async function callModel(apiKey: string, baseUrl: string, model: string, proxyUrl: string, messages: ModelMessage[], jsonMode = true) {
  return invoke<string>("model_chat", { request: { api_key: apiKey, base_url: baseUrl, model, messages, json_mode: jsonMode, proxy_url: proxyUrl } });
}

async function invokeWithTimeout<T>(command: string, args: Record<string, unknown>, timeoutMs: number, message: string): Promise<T> {
  let timer = 0;
  try {
    return await Promise.race([
      invoke<T>(command, args),
      new Promise<T>((_, reject) => { timer = window.setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    window.clearTimeout(timer);
  }
}

const ContinuousPage = memo(function ContinuousPage({ pdfDocument, pageNumber, zoom, rotation, size, highlight, viewerRef }: {
  pdfDocument: PdfDocument; pageNumber: number; zoom: number; rotation: number; size?: PageSize;
  highlight: BoundingBox | null; viewerRef: RefObject<HTMLDivElement | null>;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<PdfPage | null>(null);
  const [near, setNear] = useState(pageNumber <= 2);
  const [baseSize, setBaseSize] = useState<PageSize>(size ?? { width: 612, height: 792 });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const shell = shellRef.current;
    const root = viewerRef.current;
    if (!shell || !root) return;
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { root, rootMargin: "700px 0px", threshold: 0 });
    observer.observe(shell);
    return () => observer.disconnect();
  }, [viewerRef]);

  useEffect(() => {
    if (size) setBaseSize(size);
  }, [size]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const textContainer = textRef.current;
    if (!near) {
      pageRef.current?.cleanup();
      pageRef.current = null;
      if (canvas) { canvas.width = 0; canvas.height = 0; canvas.removeAttribute("style"); }
      textContainer?.replaceChildren();
      setReady(false);
      return;
    }
    let active = true;
    void pdfDocument.getPage(pageNumber).then((pdfPage) => {
      if (!active) { pdfPage.cleanup(); return; }
      pageRef.current = pdfPage;
      const viewport = pdfPage.getViewport({ scale: 1 });
      setBaseSize({ width: viewport.width, height: viewport.height });
    });
    return () => { active = false; };
  }, [near, pageNumber, pdfDocument]);

  useEffect(() => {
    const pdfPage = pageRef.current;
    const canvas = canvasRef.current;
    const textContainer = textRef.current;
    if (!pdfPage || !canvas || !textContainer || !near) return;
    const viewport = pdfPage.getViewport({ scale: zoom, rotation });
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    const context = canvas.getContext("2d")!;
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    textContainer.replaceChildren();
    textContainer.style.setProperty("--scale-factor", String(viewport.scale));
    const renderTask = pdfPage.render({ canvas, canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
    let textLayer: pdfjsLib.TextLayer | undefined;
    let disposed = false;
    void pdfPage.getTextContent().then((textContent) => {
      if (disposed) return;
      textLayer = new pdfjsLib.TextLayer({ textContentSource: textContent, container: textContainer, viewport });
      return textLayer.render();
    });
    renderTask.promise.then(() => setReady(true)).catch((error: unknown) => {
      if (!(error instanceof Error) || error.name !== "RenderingCancelledException") console.error(error);
    });
    return () => { disposed = true; renderTask.cancel(); textLayer?.cancel(); };
  }, [near, zoom, rotation, baseSize]);

  const rotated = rotation % 180 !== 0;
  const width = (rotated ? baseSize.height : baseSize.width) * zoom;
  const height = (rotated ? baseSize.width : baseSize.height) * zoom;
  const shownBox = highlight ? rotateBox(highlight, rotation) : null;
  return <div className="page-wrap" id={`pdf-page-${pageNumber}`} data-page={pageNumber} ref={shellRef}>
    <div className="page-number-chip">{pageNumber}</div>
    <div className={`page-sheet ${ready ? "rendered" : ""}`} style={{ width, height }}>
      <canvas ref={canvasRef} /><div ref={textRef} className="textLayer" />
      {shownBox && <div className="highlight" data-highlight="true" style={{ left: `${shownBox.x * 100}%`, top: `${shownBox.y * 100}%`, width: `${shownBox.width * 100}%`, height: `${shownBox.height * 100}%` }} />}
    </div>
  </div>;
});

const ContinuousDocument = memo(function ContinuousDocument({ pdfDocument, pages, zoom, rotation, pageSizes, highlight, viewerRef }: {
  pdfDocument: PdfDocument; pages: number; zoom: number; rotation: number; pageSizes: PageSize[]; highlight: Highlight; viewerRef: RefObject<HTMLDivElement | null>;
}) {
  return <div className="continuous-document">{Array.from({ length: pages }, (_, index) => {
    const pageNumber = index + 1;
    return <ContinuousPage key={pageNumber} pdfDocument={pdfDocument} pageNumber={pageNumber} zoom={zoom} rotation={rotation} size={pageSizes[index]} highlight={highlight?.page === pageNumber ? highlight.bbox : null} viewerRef={viewerRef} />;
  })}</div>;
});

const Thumbnail = memo(function Thumbnail({ pdfDocument, pageNumber, active, onSelect }: { pdfDocument: PdfDocument; pageNumber: number; active: boolean; onSelect: (page: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const holderRef = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(pageNumber <= 5);
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && setVisible(true), { rootMargin: "500px" });
    observer.observe(holder);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let task: ReturnType<PdfPage["render"]> | undefined;
    void pdfDocument.getPage(pageNumber).then((pdfPage) => {
      const viewport = pdfPage.getViewport({ scale: 0.2 });
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = viewport.width; canvas.height = viewport.height;
      task = pdfPage.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport });
    });
    return () => task?.cancel();
  }, [pdfDocument, pageNumber, visible]);
  return <button ref={holderRef} className={`thumbnail ${active ? "active" : ""}`} onClick={() => onSelect(pageNumber)}><canvas ref={canvasRef} /><span>{pageNumber}</span></button>;
});

const ThumbnailList = memo(function ThumbnailList({ pdfDocument, pages, activePage, onSelect }: { pdfDocument: PdfDocument; pages: number; activePage: number; onSelect: (page: number) => void }) {
  return <div className="thumb-list">{Array.from({ length: pages }, (_, index) => <Thumbnail key={index + 1} pdfDocument={pdfDocument} pageNumber={index + 1} active={activePage === index + 1} onSelect={onSelect} />)}</div>;
});

export default function App() {
  const fileInput = useRef<HTMLInputElement>(null);
  const viewer = useRef<HTMLDivElement>(null);
  const manualHost = useRef<HTMLDivElement>(null);
  const objectUrl = useRef<string | null>(null);
  const suggestionRun = useRef("");
  const pdfDownloadBusy = useRef(false);
  const [pdfDocument, setPdfDocument] = useState<PdfDocument | null>(null);
  const [fileName, setFileName] = useState("尚未打开文档");
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [pages, setPages] = useState(0);
  const [pageSizes, setPageSizes] = useState<PageSize[]>([]);
  const [zoom, setZoom] = useState(1.1);
  const [rotation, setRotation] = useState(0);
  const [highlight, setHighlight] = useState<Highlight>(null);
  const [blocks, setBlocks] = useState<TextBlock[]>([]);
  const [searchLines, setSearchLines] = useState<SearchLine[]>([]);
  const [indexing, setIndexing] = useState(false);
  const [indexProgress, setIndexProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [sideMode, setSideMode] = useState<SideMode>("thumbnails");
  const [findText, setFindText] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [asking, setAsking] = useState(false);
  const [settings, setSettings] = useState(false);
  const [provider, setProvider] = useState<ProviderId>("deepseek");
  const [apiKeys, setApiKeys] = useState<Partial<Record<ProviderId, string>>>({});
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com");
  const [model, setModel] = useState("deepseek-v4-flash");
  const [proxyUrl, setProxyUrl] = useState("");
  const [proxyDraft, setProxyDraft] = useState("");
  const [searchEngine, setSearchEngine] = useState<SearchEngineId>("bing");
  const [networkTesting, setNetworkTesting] = useState(false);
  const [networkResult, setNetworkResult] = useState<NetworkTestResult | null>(null);
  const [rememberApiKeys, setRememberApiKeys] = useState(true);
  const [settingsRestoring, setSettingsRestoring] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsFeedback, setSettingsFeedback] = useState("");
  const [suggestedQuestions, setSuggestedQuestions] = useState<string[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [rightMode, setRightMode] = useState<RightMode>("assistant");
  const [manualQuery, setManualQuery] = useState("");
  const [manualCurrentUrl, setManualCurrentUrl] = useState("");
  const [manualReady, setManualReady] = useState(false);
  const [manualBusy, setManualBusy] = useState(false);
  const [manualImporting, setManualImporting] = useState(false);
  const [manualError, setManualError] = useState("");
  const [manualRestart, setManualRestart] = useState(0);
  const [activeDocumentId, setActiveDocumentId] = useState<number | null>(null);
  const [currentSourceUrl, setCurrentSourceUrl] = useState("");
  const [currentPartNumber, setCurrentPartNumber] = useState("");
  const [currentManufacturer, setCurrentManufacturer] = useState("");
  const [libraryDocuments, setLibraryDocuments] = useState<LibraryDocument[]>([]);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [librarySavedAt, setLibrarySavedAt] = useState("");
  const [finderQuery, setFinderQuery] = useState("");
  const [finderLoading, setFinderLoading] = useState(false);
  const [finderStage, setFinderStage] = useState("");
  const [finderError, setFinderError] = useState("");
  const [finderCandidates, setFinderCandidates] = useState<ManualCandidate[]>([]);
  const [finderPlan, setFinderPlan] = useState<ManualSearchPlan | null>(null);
  const [finderImportUrl, setFinderImportUrl] = useState("");

  const providerPreset = PROVIDERS.find((item) => item.id === provider) ?? PROVIDERS[0];
  const providerName = providerPreset.name;
  const apiKey = apiKeys[provider] ?? "";
  const setApiKey = (value: string) => setApiKeys((current) => ({ ...current, [provider]: value }));
  const chooseProvider = (id: ProviderId) => {
    const preset = PROVIDERS.find((item) => item.id === id) ?? PROVIDERS[0];
    setProvider(id); setBaseUrl(preset.baseUrl); setModel(preset.model); setNetworkResult(null);
  };
  const openSettings = () => { setProxyDraft(proxyUrl); setNetworkResult(null); setSettingsFeedback(""); setSettings(true); };

  const refreshLibrary = useCallback(async (query = "") => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    setLibraryLoading(true); setLibraryError("");
    try {
      setLibraryDocuments(await invoke<LibraryDocument[]>("library_list_documents", { query }));
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
    } finally { setLibraryLoading(false); }
  }, []);

  useEffect(() => setPageInput(String(page)), [page]);
  useEffect(() => () => { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }, []);
  useEffect(() => { void refreshLibrary(); }, [refreshLibrary]);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) { setSettingsRestoring(false); return; }
    let cancelled = false;
    const restoreSettings = async () => {
      let shouldLoadCredentials = true;
      try {
        const restored = await invoke<StoredAppSettings>("app_settings_load");
        if (cancelled) return;
        const restoredProvider = PROVIDERS.some((item) => item.id === restored.provider) ? restored.provider : "deepseek";
        const restoredSearchEngine = SEARCH_ENGINES.some((item) => item.id === restored.search_engine) ? restored.search_engine : "bing";
        setProvider(restoredProvider);
        setBaseUrl(restored.base_url);
        setModel(restored.model);
        setProxyUrl(restored.proxy_url);
        setProxyDraft(restored.proxy_url);
        setSearchEngine(restoredSearchEngine);
        setRememberApiKeys(restored.remember_api_keys);
        shouldLoadCredentials = restored.remember_api_keys;
      } catch (error) {
        if (!cancelled) setSettingsFeedback(error instanceof Error ? error.message : String(error));
      }
      if (shouldLoadCredentials && !cancelled) {
        try {
          const restoredCredentials = await invoke<Partial<Record<ProviderId, string>>>("credentials_load");
          if (!cancelled) setApiKeys(restoredCredentials);
        } catch (error) {
          if (!cancelled) setSettingsFeedback(error instanceof Error ? error.message : String(error));
        }
      }
      if (!cancelled) setSettingsRestoring(false);
    };
    void restoreSettings();
    return () => { cancelled = true; };
  }, []);

  const saveSettings = async () => {
    const appliedProxy = proxyDraft.trim();
    if (!("__TAURI_INTERNALS__" in window)) {
      setProxyUrl(appliedProxy); setSettings(false); return;
    }
    setSettingsSaving(true); setSettingsFeedback("");
    try {
      await invoke("credentials_save", { request: { credentials: apiKeys, remember: rememberApiKeys } });
      await invoke("app_settings_save", { settings: {
        provider, base_url: baseUrl.trim(), model: model.trim(), proxy_url: appliedProxy,
        search_engine: searchEngine, remember_api_keys: rememberApiKeys,
      } satisfies StoredAppSettings });
      setBaseUrl(baseUrl.trim()); setModel(model.trim()); setProxyUrl(appliedProxy); setSettings(false);
    } catch (error) {
      setSettingsFeedback(error instanceof Error ? error.message : String(error));
    } finally { setSettingsSaving(false); }
  };

  const clearSavedCredentials = async () => {
    if (!window.confirm("清除所有模型服务商已保存的 API Key？此操作不会删除文档库。")) return;
    setSettingsSaving(true); setSettingsFeedback("");
    try {
      if ("__TAURI_INTERNALS__" in window) {
        await invoke("credentials_clear");
        await invoke("app_settings_save", { settings: {
          provider, base_url: baseUrl.trim(), model: model.trim(), proxy_url: proxyDraft.trim(),
          search_engine: searchEngine, remember_api_keys: false,
        } satisfies StoredAppSettings });
      }
      setApiKeys({}); setRememberApiKeys(false); setSettingsFeedback("已清除所有已保存的 API Key。");
    } catch (error) {
      setSettingsFeedback(error instanceof Error ? error.message : String(error));
    } finally { setSettingsSaving(false); }
  };

  const openFile = useCallback(async (file?: File, options: OpenDocumentOptions = {}) => {
    if (!file || (file.type && file.type !== "application/pdf")) return;
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data: data.slice() }).promise;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
    suggestionRun.current = "";
    setSuggestedQuestions([]); setSuggestionsLoading(false);
    setPdfDocument(pdf); setFileName(file.name); setPages(pdf.numPages); setPage(1); setRotation(0); setHighlight(null); setMessages([]); setPageSizes([]); setBlocks([]); setSearchLines([]); setFindText(""); setIndexProgress(0);
    setCurrentSourceUrl(options.sourceUrl ?? options.cached?.source_url ?? "");
    setCurrentPartNumber(options.partNumber ?? options.cached?.part_number ?? "");
    setCurrentManufacturer(options.manufacturer ?? options.cached?.manufacturer ?? "");

    if (options.cached) {
      const restored = options.restored ?? await restoreLibraryPayload(options.cached);
      const cachedBlocks = restored.blocks;
      const cachedSearchLines = restored.searchLines;
      const cachedPageSizes = restored.pageSizes;
      const cachedQuestions = restored.questions;
      const cachedMessages = restored.messages;
      setBlocks(cachedBlocks); setSearchLines(cachedSearchLines); setPageSizes(cachedPageSizes);
      setSuggestedQuestions(cachedQuestions.length ? cachedQuestions : buildLocalQuestions(cachedBlocks, file.name));
      setMessages(cachedMessages); setIndexProgress(100); setIndexing(false);
      setActiveDocumentId(options.cached.id); setLibrarySavedAt(options.cached.updated_at);
      return;
    }

    setActiveDocumentId(null); setLibrarySavedAt(""); setIndexing(true);
    const chunks: TextBlock[] = [];
    const exactLines: SearchLine[] = [];
    const sizes: PageSize[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const pdfPage = await pdf.getPage(pageNumber);
      const viewport = pdfPage.getViewport({ scale: 1 });
      sizes.push({ width: viewport.width, height: viewport.height });
      const content = await pdfPage.getTextContent();
      const items: TextBlock[] = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
        const height = Math.abs(item.height || tx[3]);
        items.push({ page: pageNumber, text: item.str.trim(), bbox: { x: clamp(tx[4] / viewport.width, 0, 1), y: clamp((tx[5] - height) / viewport.height, 0, 1), width: clamp(item.width / viewport.width, 0.004, 1), height: clamp(height / viewport.height, 0.006, 1) } });
      }
      exactLines.push(...buildSearchLines(items));
      for (let start = 0; start < items.length; start += 12) {
        const group = items.slice(start, start + 12);
        if (group.length) chunks.push({ page: pageNumber, text: group.map((item) => item.text).join(" "), bbox: unionBoxes(group.map((item) => item.bbox)) });
      }
      if (pageNumber % 4 === 0 || pageNumber === pdf.numPages) setIndexProgress(Math.round((pageNumber / pdf.numPages) * 100));
      if (pageNumber % 12 === 0 || pageNumber === pdf.numPages) setPageSizes([...sizes]);
      if (pageNumber % 2 === 0) await yieldToBrowser();
    }
    const localQuestions = buildLocalQuestions(chunks, file.name);
    const partNumber = options.partNumber?.trim() || inferPartNumber(file.name, chunks);
    const manufacturer = options.manufacturer?.trim() ?? "";
    setBlocks(chunks); setSearchLines(exactLines); setPageSizes(sizes); setSuggestedQuestions(localQuestions);
    setCurrentPartNumber(partNumber); setCurrentManufacturer(manufacturer); setIndexing(false);

    if (("__TAURI_INTERNALS__" in window) && !options.skipSave) {
      try {
        const serialized = await serializeLibraryPayload(data, chunks, exactLines, sizes, localQuestions);
        const saved = await invoke<LibraryDocument>("library_save_document", { request: {
          file_name: file.name,
          source_url: options.sourceUrl ?? "",
          part_number: partNumber,
          manufacturer,
          page_count: pdf.numPages,
          data_base64: serialized.data_base64,
          blocks_json: serialized.blocks_json,
          search_lines_json: serialized.search_lines_json,
          page_sizes_json: serialized.page_sizes_json,
          questions_json: serialized.questions_json,
          messages_json: "[]",
        } });
        setActiveDocumentId(saved.id); setLibrarySavedAt(saved.updated_at); setLibraryError("");
        void refreshLibrary();
      } catch (error) {
        setLibraryError(`PDF 已打开，但保存到文档库失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }, [refreshLibrary]);

  useEffect(() => {
    if (!pdfDocument || indexing) return;
    const fallback = buildLocalQuestions(blocks, fileName);
    setSuggestedQuestions((current) => current.length ? current : fallback);
    if (!blocks.length || settings || asking || !apiKey.trim() || !model.trim()) return;

    const signature = `${fileName}:${blocks.length}:${provider}:${baseUrl}:${model}:${apiKey.slice(-6)}`;
    if (suggestionRun.current === signature) return;
    let cancelled = false;
    let started = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      started = true;
      suggestionRun.current = signature;
      setSuggestionsLoading(true);
      const representative = blocks.filter((_, index) => index < 18 || index % Math.max(1, Math.floor(blocks.length / 12)) === 0).slice(0, 32);
      const documentSample = representative.map((block) => `[Page ${block.page}] ${block.text}`).join("\n").slice(0, 10000);
      void callModel(apiKey, baseUrl, model, proxyUrl, [
        { role: "system", content: "你是工程技术文档的阅读向导。根据文件名和文档片段，生成 3-5 个用户最值得询问、并且能从该文档中找到证据的问题。问题要具体，优先覆盖核心用途、关键参数、配置方法、接口/时序或故障限制。不要编造片段中没有出现的器件或功能。只输出 JSON：{\"questions\":[\"问题1\",\"问题2\"]}。" },
        { role: "user", content: `文件名：${fileName}\n\n文档片段：\n${documentSample}` },
      ]).then((raw) => {
        if (cancelled) return;
        const parsed = parseModelObject<{ questions?: unknown[] }>(raw);
        const questions = (parsed.questions ?? []).filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter((item, index, all) => item.length >= 6 && item.length <= 120 && all.indexOf(item) === index).slice(0, 5);
        if (questions.length >= 3) setSuggestedQuestions(questions);
      }).catch(() => {
        // The local suggestions remain usable when the API is unavailable.
      }).finally(() => {
        if (!cancelled) setSuggestionsLoading(false);
      });
    }, 1500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (!started && suggestionRun.current === signature) suggestionRun.current = "";
      if (started) setSuggestionsLoading(false);
    };
  }, [apiKey, asking, baseUrl, blocks, fileName, indexing, model, pdfDocument, provider, proxyUrl, settings]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window) || !activeDocumentId || indexing) return;
    const timer = window.setTimeout(() => {
      void invoke("library_update_document", { request: {
        id: activeDocumentId,
        part_number: currentPartNumber,
        manufacturer: currentManufacturer,
        questions_json: JSON.stringify(suggestedQuestions),
        messages_json: JSON.stringify(messages),
      } }).then(() => setLibrarySavedAt(new Date().toLocaleString())).catch((error) => {
        setLibraryError(`分析结果保存失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [activeDocumentId, currentManufacturer, currentPartNumber, indexing, messages, suggestedQuestions]);

  const scrollToPage = useCallback((requested: number, behavior: ScrollBehavior = "smooth") => {
    const target = clamp(Math.round(requested || 1), 1, pages || 1);
    setPage(target);
    requestAnimationFrame(() => {
      const root = viewer.current;
      const element = window.document.getElementById(`pdf-page-${target}`);
      if (!root || !element) return;
      const rootRect = root.getBoundingClientRect();
      const pageRect = element.getBoundingClientRect();
      const top = root.scrollTop + pageRect.top - rootRect.top - 18;
      root.scrollTo({ top: Math.max(0, top), behavior });
    });
  }, [pages]);
  const focusHighlight = useCallback((target: number) => window.setTimeout(() => {
    const root = viewer.current;
    const element = window.document.querySelector(`#pdf-page-${target} [data-highlight="true"]`);
    if (!root || !(element instanceof HTMLElement)) return;
    const rootRect = root.getBoundingClientRect();
    const highlightRect = element.getBoundingClientRect();
    const top = root.scrollTop + highlightRect.top - rootRect.top - (root.clientHeight - highlightRect.height) / 2;
    root.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, 180), []);
  const controller: ViewerController = useMemo(() => ({
    gotoPage(target) { scrollToPage(target); },
    setZoom(scale) { setZoom(clamp(scale, 0.5, 3)); },
    highlightRegion(target, bbox) { setHighlight({ page: target, bbox }); scrollToPage(target); focusHighlight(target); },
    zoomToRegion(target, bbox) {
      const root = viewer.current; const size = pageSizes[target - 1];
      if (root && size) setZoom(clamp(Math.min((root.clientWidth - 110) / (size.width * Math.max(bbox.width, 0.18)), (root.clientHeight - 110) / (size.height * Math.max(bbox.height, 0.12))), 0.5, 3));
      setHighlight({ page: target, bbox }); scrollToPage(target); focusHighlight(target);
    },
    clearHighlights() { setHighlight(null); },
  }), [focusHighlight, pageSizes, scrollToPage]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']")) return;
      if (event.key === "PageDown" || event.key === "ArrowRight") { event.preventDefault(); scrollToPage(page + 1); }
      if (event.key === "PageUp" || event.key === "ArrowLeft") { event.preventDefault(); scrollToPage(page - 1); }
      if (event.key === "Home") { event.preventDefault(); scrollToPage(1); }
      if (event.key === "End") { event.preventDefault(); scrollToPage(pages); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); setSidebar(true); setSideMode("search"); }
      if ((event.ctrlKey || event.metaKey) && ["+", "="].includes(event.key)) { event.preventDefault(); setZoom((value) => clamp(value + 0.15, 0.5, 3)); }
      if ((event.ctrlKey || event.metaKey) && event.key === "-") { event.preventDefault(); setZoom((value) => clamp(value - 0.15, 0.5, 3)); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [page, pages, scrollToPage]);

  useEffect(() => {
    const root = viewer.current;
    if (!root || !pdfDocument) return;
    let animationFrame = 0;
    const updateCurrentPage = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const rootRect = root.getBoundingClientRect();
        const readingLine = rootRect.top + Math.min(90, root.clientHeight * 0.18);
        const readingX = rootRect.left + root.clientWidth / 2;
        const pageElement = window.document.elementFromPoint(readingX, readingLine)?.closest<HTMLElement>(".page-wrap");
        if (pageElement) setPage(Number(pageElement.dataset.page || 1));
      });
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 28 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? root.clientHeight : 1;
      if (event.ctrlKey || event.metaKey) {
        setZoom((value) => clamp(value + (event.deltaY < 0 ? 0.08 : -0.08), 0.5, 3));
        return;
      }
      root.scrollBy({ left: event.deltaX * unit, top: event.deltaY * unit, behavior: "auto" });
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    root.addEventListener("scroll", updateCurrentPage, { passive: true });
    updateCurrentPage();
    return () => {
      cancelAnimationFrame(animationFrame);
      root.removeEventListener("wheel", onWheel);
      root.removeEventListener("scroll", updateCurrentPage);
    };
  }, [pdfDocument]);

  const findResults = useMemo(() => findDocument(searchLines, findText), [findText, searchLines]);
  const activateFindResult = useCallback((requested: number) => {
    if (!findResults.length) return;
    const target = (requested + findResults.length) % findResults.length;
    setFindIndex(target);
    const result = findResults[target];
    controller.highlightRegion(result.page, result.bbox);
  }, [controller, findResults]);
  useEffect(() => {
    setFindIndex(0);
    if (findText.trim() && findResults[0]) controller.highlightRegion(findResults[0].page, findResults[0].bbox);
    else if (!findText.trim()) controller.clearHighlights();
  }, [findResults, findText]);
  const fitWidth = () => { const size = pageSizes[page - 1]; if (size && viewer.current) controller.setZoom((viewer.current.clientWidth - 76) / (rotation % 180 ? size.height : size.width)); };
  const fitPage = () => { const size = pageSizes[page - 1]; if (size && viewer.current) { const width = rotation % 180 ? size.height : size.width; const height = rotation % 180 ? size.width : size.height; controller.setZoom(Math.min((viewer.current.clientWidth - 76) / width, (viewer.current.clientHeight - 76) / height)); } };
  const saveCopy = () => { if (!objectUrl.current) return; const link = window.document.createElement("a"); link.href = objectUrl.current; link.download = fileName; link.click(); };

  const openPdfUrl = useCallback(async (requestedUrl: string, metadata: { partNumber?: string; manufacturer?: string } = {}) => {
    const url = requestedUrl.trim();
    if (!url || pdfDownloadBusy.current) return false;
    pdfDownloadBusy.current = true;
    setManualImporting(true); setManualError("");
    try {
      const downloaded = await invoke<DownloadedPdf>("download_pdf", { request: { url, proxy_url: proxyUrl } });
      const decoded = await decodePdfPayload(downloaded.data_base64);
      await openFile(new File([decoded.buffer], downloaded.file_name, { type: "application/pdf" }), { sourceUrl: url, partNumber: metadata.partNumber, manufacturer: metadata.manufacturer });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setManualError(message); setFinderError(message);
      return false;
    } finally {
      pdfDownloadBusy.current = false;
      setManualImporting(false);
    }
  }, [openFile, proxyUrl]);

  const searchSmartManual = async (event: FormEvent) => {
    event.preventDefault();
    const query = finderQuery.trim();
    if (!query || finderLoading) return;
    if (!("__TAURI_INTERNALS__" in window)) {
      setFinderError("智能找手册需要在 SpecPilot 桌面版中使用");
      return;
    }
    setFinderLoading(true); setFinderError(""); setFinderCandidates([]);
    let plan: ManualSearchPlan = { part_number: query.toUpperCase(), manufacturer: "", official_domains: [], queries: [`${query} datasheet PDF`] };
    if (apiKey.trim()) {
      setFinderStage(`${providerName} 正在识别型号与官方站点…`);
      try {
        const raw = await callModel(apiKey, baseUrl, model, proxyUrl, [
          { role: "system", content: "你是电子器件手册检索规划器。根据输入识别准确型号、厂商和厂商官方域名，并生成 2-4 条英文搜索词。不要猜测 PDF URL。只输出 JSON：{\"part_number\":\"\",\"manufacturer\":\"\",\"official_domains\":[\"st.com\"],\"queries\":[\"... datasheet PDF\"]}。不确定的字段用空字符串或空数组。" },
          { role: "user", content: query },
        ]);
        const parsed = parseModelObject<Partial<ManualSearchPlan>>(raw);
        plan = {
          part_number: typeof parsed.part_number === "string" && parsed.part_number.trim() ? parsed.part_number.trim() : plan.part_number,
          manufacturer: typeof parsed.manufacturer === "string" ? parsed.manufacturer.trim() : "",
          official_domains: Array.isArray(parsed.official_domains) ? parsed.official_domains.filter((value): value is string => typeof value === "string").slice(0, 4) : [],
          queries: Array.isArray(parsed.queries) ? parsed.queries.filter((value): value is string => typeof value === "string").slice(0, 4) : plan.queries,
        };
      } catch {
        setFinderStage("AI 识别不可用，正在使用型号直接检索…");
      }
    } else {
      setFinderStage("未配置模型，正在使用型号直接检索…");
    }
    setFinderPlan(plan); setFinderStage("正在搜索官方站点并验证 PDF 直链…");
    try {
      const candidates = await invoke<ManualCandidate[]>("search_manuals", { request: {
        query,
        queries: plan.queries,
        part_number: plan.part_number,
        manufacturer: plan.manufacturer,
        official_domains: plan.official_domains,
        proxy_url: proxyUrl,
      } });
      setFinderCandidates(candidates);
      setFinderStage(`找到 ${candidates.length} 个候选，已按准确度排序`);
    } catch (error) {
      setFinderError(error instanceof Error ? error.message : String(error)); setFinderStage("");
    } finally { setFinderLoading(false); }
  };

  const importSmartCandidate = async (candidate: ManualCandidate) => {
    if (finderImportUrl) return;
    setFinderImportUrl(candidate.url); setFinderError("");
    const imported = await openPdfUrl(candidate.url, { partNumber: finderPlan?.part_number, manufacturer: finderPlan?.manufacturer });
    setFinderImportUrl("");
    if (imported) setRightMode("assistant");
  };

  const openLibraryDocument = async (document: LibraryDocument) => {
    if (!("__TAURI_INTERNALS__" in window) || libraryLoading) return;
    setLibraryLoading(true); setLibraryError("");
    try {
      const loaded = await invoke<LibraryLoadedDocument>("library_load_document", { id: document.id });
      const restored = await restoreLibraryPayload(loaded);
      await openFile(new File([restored.buffer], loaded.file_name, { type: "application/pdf" }), { cached: loaded, restored, skipSave: true });
      setRightMode("assistant");
      void refreshLibrary(libraryQuery);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
    } finally { setLibraryLoading(false); }
  };

  const deleteLibraryDocument = async (document: LibraryDocument) => {
    if (!("__TAURI_INTERNALS__" in window) || !window.confirm(`从文档库删除“${document.file_name}”？\n原始 PDF 和缓存分析都会删除。`)) return;
    setLibraryLoading(true); setLibraryError("");
    try {
      await invoke("library_delete_document", { id: document.id });
      if (activeDocumentId === document.id) { setActiveDocumentId(null); setLibrarySavedAt(""); }
      await refreshLibrary(libraryQuery);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
    } finally { setLibraryLoading(false); }
  };

  const readManualBounds = useCallback((): ManualBounds | null => {
    const host = manualHost.current;
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    if (rightMode !== "manual") {
      setManualReady(false);
      void invoke("manual_panel_destroy").catch(() => undefined);
      return;
    }
    setManualReady(false);
    let cancelled = false;
    let frame = 0;
    const syncBounds = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bounds = readManualBounds();
        if (bounds) void invoke("manual_panel_set_bounds", { bounds });
      });
    };
    const start = async () => {
      const bounds = readManualBounds();
      if (!bounds) { frame = requestAnimationFrame(() => void start()); return; }
      try {
        await invokeWithTimeout("manual_panel_create", { bounds, proxyUrl }, 12000, "WebView2 启动超时。请检查代理，或点击重试；PDF 阅读器仍可正常使用。");
        if (!cancelled) { setManualReady(true); setManualError(""); }
      } catch (error) {
        if (!cancelled) { setManualReady(false); setManualError(error instanceof Error ? error.message : String(error)); }
      }
    };
    void start();
    const observer = new ResizeObserver(syncBounds);
    if (manualHost.current) observer.observe(manualHost.current);
    window.addEventListener("resize", syncBounds);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
      void invoke("manual_panel_visibility", { visible: false });
    };
  }, [manualRestart, proxyUrl, readManualBounds, rightMode]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window) || rightMode !== "manual" || !manualReady) return;
    void invoke("manual_panel_visibility", { visible: !settings });
  }, [manualReady, rightMode, settings]);

  const restartManualPanel = async () => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    setManualReady(false); setManualBusy(false); setManualError("正在安全重建在线手册…");
    try {
      await invokeWithTimeout("manual_panel_destroy", {}, 5000, "旧网页区域未及时退出，将继续尝试重新连接。");
    } catch {
      // A stuck webview must not prevent the main PDF reader from remaining usable.
    }
    setManualRestart((value) => value + 1);
  };

  const navigateManual = async () => {
    const query = manualQuery.trim();
    if (!query || manualBusy) return;
    if (!("__TAURI_INTERNALS__" in window)) {
      setManualError("在线网页需要在 SpecPilot 桌面版中使用");
      return;
    }
    if (!manualReady) {
      setManualError("在线手册尚未就绪，请先点击“重试在线手册”");
      return;
    }
    setManualBusy(true); setManualError("");
    try {
      await invokeWithTimeout("manual_panel_navigate", { query, searchEngine }, 8000, "网页导航超时。请检查搜索引擎或代理设置后重试。");
    } catch (error) {
      setManualError(error instanceof Error ? error.message : String(error));
    } finally { setManualBusy(false); }
  };

  const manualAction = async (action: "back" | "forward" | "reload") => {
    if (!("__TAURI_INTERNALS__" in window) || !manualReady) return;
    setManualError("");
    try { await invokeWithTimeout("manual_panel_action", { action }, 5000, "网页操作超时，可重建在线手册后重试。"); }
    catch (error) { setManualError(error instanceof Error ? error.message : String(error)); }
  };

  const importManualPdf = async () => {
    if (!("__TAURI_INTERNALS__" in window) || manualImporting) return;
    setManualError("");
    try {
      const url = await invokeWithTimeout<string>("manual_panel_current_url", {}, 5000, "读取当前 PDF 地址超时，请重试。");
      setManualCurrentUrl(url); setManualQuery(url);
      await openPdfUrl(url);
    } catch (error) {
      setManualError(error instanceof Error ? error.message : String(error));
    }
  };

  const testNetwork = async (target: "manual" | "model") => {
    if (networkTesting || !("__TAURI_INTERNALS__" in window)) return;
    const url = target === "model" ? baseUrl : (SEARCH_ENGINES.find((item) => item.id === searchEngine)?.home ?? SEARCH_ENGINES[0].home);
    if (!url.trim()) { setNetworkResult({ reachable: false, message: "请先填写 API Base URL" }); return; }
    setNetworkTesting(true); setNetworkResult(null);
    try {
      const result = await invoke<NetworkTestResult>("network_test", { request: { url, proxy_url: proxyDraft } });
      setNetworkResult(result);
    } catch (error) {
      setNetworkResult({ reachable: false, message: error instanceof Error ? error.message : String(error) });
    } finally { setNetworkTesting(false); }
  };

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let stopPdf: (() => void) | undefined;
    let stopPage: (() => void) | undefined;
    void listen<string>("manual-pdf-found", (event) => { setManualBusy(false); void openPdfUrl(event.payload); }).then((unlisten) => { stopPdf = unlisten; });
    void listen<string>("manual-page-changed", (event) => {
      setManualCurrentUrl(event.payload); setManualQuery(event.payload); setManualBusy(false); setManualError("");
    }).then((unlisten) => { stopPage = unlisten; });
    return () => { stopPdf?.(); stopPage?.(); };
  }, [openPdfUrl]);

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text || !pdfDocument || indexing || asking) return;
    if (!apiKey.trim()) { openSettings(); return; }
    setMessages((current) => [...current, { role: "user", text }]); setQuestion(""); setAsking(true);
    try {
      const planRaw = await callModel(apiKey, baseUrl, model, proxyUrl, [
        { role: "system", content: "你是技术文档检索规划器。把用户问题转换成适合在英文/中文 datasheet 中检索的 2-5 个精确关键词或短语。只输出 JSON：{\"queries\":[\"...\"]}。不要回答问题。" },
        { role: "user", content: text },
      ]);
      let queries = [text];
      try { const parsed = parseModelObject<{ queries?: string[] }>(planRaw); if (parsed.queries?.length) queries = [text, ...parsed.queries]; } catch { /* use original */ }
      await yieldToBrowser();
      const candidates = searchDocument(blocks, queries, 12);
      if (!candidates.length) throw new Error("没有检索到可交给模型的文档证据，请换用更精确的术语");
      const evidence = candidates.map((source, index) => `[S${index + 1}] Page ${source.page}\n${source.text}`).join("\n\n");
      const answerRaw = await callModel(apiKey, baseUrl, model, proxyUrl, [
        { role: "system", content: "你是工程技术文档助手。只能根据证据回答，不得补充证据之外的参数。输出 JSON：{\"answer\":\"中文回答\",\"source_ids\":[\"S1\"],\"action\":\"highlight\"}。source_ids 只选真正支持回答的证据；action 只能是 none、goto、highlight、zoom。图表/时序图适合 zoom，文本参数适合 highlight。" },
        { role: "user", content: `问题：${text}\n\n证据：\n${evidence}` },
      ]);
      const parsed = JSON.parse(answerRaw) as { answer?: string; source_ids?: string[]; action?: "none" | "goto" | "highlight" | "zoom" };
      const sources = (parsed.source_ids ?? []).map((id) => candidates[Number(id.replace(/\D/g, "")) - 1]).filter(Boolean);
      const answer = parsed.answer?.trim() || `${providerName} 未返回有效回答`;
      setMessages((current) => [...current, { role: "assistant", text: answer, sources }]);
      const first = sources[0];
      if (first && parsed.action === "zoom") controller.zoomToRegion(first.page, first.bbox);
      else if (first && parsed.action === "goto") controller.gotoPage(first.page);
      else if (first && parsed.action !== "none") controller.highlightRegion(first.page, first.bbox);
    } catch (error) {
      setMessages((current) => [...current, { role: "assistant", text: error instanceof Error ? error.message : String(error), error: true }]);
    } finally { setAsking(false); }
  };

  return <main className="app" onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); void openFile(event.dataTransfer.files[0]); }}>
    <header className="topbar">
      <div className="brand"><span className="brand-mark">S</span><span>SpecPilot</span><small>DESKTOP PDF + AI</small></div>
      <div className="filename"><span className={pdfDocument ? "status-dot active" : "status-dot"} />{fileName}</div>
      <div className="header-actions"><button className="ghost" onClick={() => setRightMode("finder")}>⌁ 智能找手册</button><button className="ghost" onClick={() => { setRightMode("library"); void refreshLibrary(libraryQuery); }}>▤ 文档库</button><button className="ghost" onClick={() => { setRightMode("assistant"); openSettings(); }}>⚙ 模型</button><button className="primary" onClick={() => fileInput.current?.click()}>＋ 打开 PDF</button></div>
      <input ref={fileInput} hidden type="file" accept="application/pdf" onChange={(event) => void openFile(event.target.files?.[0])} />
    </header>
    <section className="workspace">
      <section className="viewer-panel">
        <div className="viewer-toolbar">
          <div className="tool-group"><button title="侧栏" onClick={() => setSidebar((value) => !value)}>☰</button><button title="查找 (Ctrl+F)" disabled={!pdfDocument} onClick={() => { setSidebar(true); setSideMode("search"); }}>⌕</button></div>
          <div className="tool-group"><button title="上一页" disabled={!pdfDocument || page <= 1} onClick={() => scrollToPage(page - 1)}>←</button><label><input value={pageInput} disabled={!pdfDocument} onChange={(event) => setPageInput(event.target.value.replace(/\D/g, ""))} onBlur={() => scrollToPage(Number(pageInput))} onKeyDown={(event) => event.key === "Enter" && scrollToPage(Number(pageInput))} /><span>/ {pages || "—"}</span></label><button title="下一页" disabled={!pdfDocument || page >= pages} onClick={() => scrollToPage(page + 1)}>→</button></div>
          <div className="tool-group"><button title="缩小" disabled={!pdfDocument} onClick={() => controller.setZoom(zoom - 0.15)}>−</button><span className="zoom-value">{Math.round(zoom * 100)}%</span><button title="放大" disabled={!pdfDocument} onClick={() => controller.setZoom(zoom + 0.15)}>＋</button></div>
          <div className="tool-group"><button disabled={!pdfDocument} onClick={fitWidth}>适合宽度</button><button disabled={!pdfDocument} onClick={fitPage}>适合页面</button></div>
          <div className="tool-group"><button title="逆时针旋转" disabled={!pdfDocument} onClick={() => setRotation((value) => (value + 270) % 360)}>↶</button><button title="顺时针旋转" disabled={!pdfDocument} onClick={() => setRotation((value) => (value + 90) % 360)}>↷</button><button title="另存副本" disabled={!pdfDocument} onClick={saveCopy}>⇩</button><button title="打印" disabled={!pdfDocument} onClick={() => window.print()}>⎙</button><button title="全屏" onClick={() => void (window.document.fullscreenElement ? window.document.exitFullscreen() : window.document.documentElement.requestFullscreen())}>⛶</button></div>
        </div>
        <div className="reader-body">
          {sidebar && <aside className="pdf-sidebar"><div className="side-tabs"><button className={sideMode === "thumbnails" ? "active" : ""} onClick={() => setSideMode("thumbnails")}>缩略图</button><button className={sideMode === "search" ? "active" : ""} onClick={() => setSideMode("search")}>查找</button></div>{sideMode === "thumbnails" ? pdfDocument && <ThumbnailList pdfDocument={pdfDocument} pages={pages} activePage={page} onSelect={scrollToPage} /> : <div className="find-panel"><input autoFocus value={findText} onChange={(event) => setFindText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); activateFindResult(findIndex + (event.shiftKey ? -1 : 1)); } }} placeholder="在文档中查找…" /><div className="find-summary"><small>{findText ? findResults.length ? `${findIndex + 1} / ${findResults.length}` : "未找到" : "输入关键词"}</small><span><button disabled={!findResults.length} title="上一个结果" onClick={() => activateFindResult(findIndex - 1)}>↑</button><button disabled={!findResults.length} title="下一个结果" onClick={() => activateFindResult(findIndex + 1)}>↓</button></span></div><div className="find-list">{findResults.map((result, index) => <button className={index === findIndex ? "active" : ""} key={`${result.page}-${index}`} onClick={() => activateFindResult(index)}><b>第 {result.page} 页</b><span>{result.text}</span></button>)}</div></div>}</aside>}
          <div className={`viewer ${pdfDocument ? "" : "viewer-empty"}`} ref={viewer} tabIndex={0} aria-label="PDF 连续阅读区">
            {pdfDocument ? <ContinuousDocument pdfDocument={pdfDocument} pages={pages} zoom={zoom} rotation={rotation} pageSizes={pageSizes} highlight={highlight} viewerRef={viewer} /> : <div className={`empty-state ${dragging ? "dragging" : ""}`} onClick={() => fileInput.current?.click()}><div className="document-icon"><span>PDF</span></div><h1>打开技术文档</h1><p>拖放 PDF 或从本地选择。支持连续阅读、搜索、复制文本、打印以及 AI 证据定位。</p><button className="secondary">选择 PDF 文件</button><div className="features"><span>✓ 完整阅读</span><span>✓ 本地解析</span><span>✓ AI 可追溯</span></div></div>}
          </div>
        </div>
        <div className="statusbar"><span>{pdfDocument ? `第 ${page} 页，共 ${pages} 页 · 旋转 ${rotation}°` : "等待文档"}</span><span>{indexing ? `正在建立索引 ${indexProgress}%` : pdfDocument ? `${blocks.length.toLocaleString()} 个段落已索引` : "PDF.js 引擎就绪"}</span><span>{activeDocumentId ? `✓ 文档库已保存${librarySavedAt ? ` · ${librarySavedAt}` : ""}` : "滚轮浏览 · Ctrl+滚轮缩放 · Ctrl+F 查找"}</span></div>
      </section>
      <aside className="chat-panel">
        <div className="right-tabs" role="tablist" aria-label="右侧工具">
          <button className={rightMode === "assistant" ? "active" : ""} onClick={() => setRightMode("assistant")}>✦ AI 助手</button>
          <button className={rightMode === "finder" || rightMode === "manual" ? "active" : ""} onClick={() => setRightMode("finder")}>⌁ 智能找手册</button>
          <button className={rightMode === "library" ? "active" : ""} onClick={() => { setRightMode("library"); void refreshLibrary(libraryQuery); }}>▤ 文档库</button>
        </div>
        {rightMode === "assistant" ? <>
          <div className="chat-title"><div><span className="spark">✦</span><strong>AI 文档助手</strong></div><span className={apiKey ? "local-badge ready" : "local-badge"}>{apiKey ? `${providerName} · ${model}` : "未配置"}</span></div>
          <div className="chat-body">
            {!messages.length ? <div className="chat-empty">
              <div className="orb">✦</div><h2>{pdfDocument ? "你可能想了解" : "先检索，再让 AI 回答"}</h2>
              <p>{!pdfDocument ? "先打开 PDF，再配置任一兼容模型。" : suggestionsLoading ? `${providerName} 正在结合文档内容生成推荐问题…` : apiKey ? "这些问题根据当前 PDF 的标题、关键段落和技术术语生成。" : "当前显示本地生成的问题；配置模型后会自动生成更具体的推荐。"}</p>
              <div className="suggestions">
                {indexing && !suggestedQuestions.length ? <button disabled>正在分析文档结构…<span>⋯</span></button> : suggestedQuestions.map((item) => <button key={item} disabled={!pdfDocument} onClick={() => setQuestion(item)}>{item}<span>↗</span></button>)}
              </div>
            </div> : messages.map((message, index) => <div className={`message ${message.role} ${message.error ? "error" : ""}`} key={index}><span className="message-label">{message.role === "user" ? "你" : providerName.toUpperCase()}</span><p>{message.text}</p>{message.sources?.map((source, sourceIndex) => <button className="source" key={sourceIndex} onClick={() => controller.highlightRegion(source.page, source.bbox)}><span>第 {source.page} 页</span><em>{source.text}</em><b>定位 ↗</b></button>)}</div>)}
            {asking && <div className="thinking"><span /><span /><span /> {providerName} 正在分析证据</div>}
          </div>
          <form className="composer" onSubmit={(event) => void ask(event)}><textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} disabled={!pdfDocument || asking} placeholder={pdfDocument ? "询问参数、寄存器或图表位置…" : "请先打开一份 PDF"} /><div><span>{indexing ? `索引中 ${indexProgress}%` : apiKey ? `${providerName} 已配置 · Enter 发送` : "需要配置模型"}</span><button disabled={!pdfDocument || indexing || asking || !question.trim()}>↑</button></div></form>
        </> : rightMode === "finder" ? <section className="finder-panel">
          <div className="tool-panel-head">
            <div><span className="spark">⌁</span><strong>智能找手册</strong></div>
            <button type="button" onClick={() => setRightMode("manual")}>网页备用</button>
          </div>
          <form className="finder-search" onSubmit={(event) => void searchSmartManual(event)}>
            <label htmlFor="finder-query">芯片型号或手册名称</label>
            <div>
              <input id="finder-query" value={finderQuery} onChange={(event) => { setFinderQuery(event.target.value); setFinderError(""); }} placeholder="例如 STM32G474RE、TPS5430 datasheet" autoComplete="off" />
              <button type="submit" disabled={finderLoading || !finderQuery.trim()}>{finderLoading ? "检索中…" : "查找 PDF"}</button>
            </div>
            <p>{apiKey ? `${providerName} 负责识别准确型号和厂商，SpecPilot 负责搜索并验证 PDF。` : "未配置 AI 也可按型号搜索；配置模型后可提高型号与官方站点识别率。"}</p>
          </form>
          <div className="finder-body">
            {finderStage && <div className={`finder-status ${finderLoading ? "loading" : ""}`}><span />{finderStage}</div>}
            {finderError && <div className="panel-error">{finderError}</div>}
            {!finderLoading && !finderError && !finderCandidates.length && <div className="finder-empty">
              <span>PDF</span><strong>输入准确型号，优先查找官方手册</strong>
              <p>搜索结果会检查网址、型号匹配度、官方域名和文件内容。通过 PDF 验证的候选可一键下载、导入并保存到文档库。</p>
            </div>}
            {!!finderCandidates.length && <div className="candidate-list">{finderCandidates.map((candidate) => <article className="candidate-card" key={candidate.url}>
              <div className="candidate-top"><span className="confidence">匹配 {Math.min(candidate.score, 100)}</span><div className="candidate-tags">{candidate.official && <b>官方</b>}{candidate.verified_pdf ? <b className="verified">已验证 PDF</b> : <b className="unverified">待验证</b>}</div></div>
              <h3>{candidate.title || finderPlan?.part_number || "Datasheet"}</h3>
              <a href={candidate.url} target="_blank" rel="noreferrer" title={candidate.url}>{candidate.host || candidate.url}</a>
              {candidate.snippet && <p>{candidate.snippet}</p>}
              <small>{candidate.reason}</small>
              <div className="candidate-actions"><button type="button" disabled={!!finderImportUrl} onClick={() => void importSmartCandidate(candidate)}>{finderImportUrl === candidate.url ? "正在下载并验证…" : "下载、导入并保存"}</button></div>
            </article>)}</div>}
          </div>
        </section> : rightMode === "library" ? <section className="library-panel">
          <div className="tool-panel-head">
            <div><span className="spark">▤</span><strong>文档库</strong></div>
            <span className="library-count">{libraryDocuments.length} 份</span>
          </div>
          <form className="library-search" onSubmit={(event) => { event.preventDefault(); void refreshLibrary(libraryQuery); }}>
            <input aria-label="搜索文档库" value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="搜索文件名、型号或厂商" />
            <button type="submit" disabled={libraryLoading}>{libraryLoading ? "…" : "搜索"}</button>
          </form>
          <div className="library-list">
            {libraryError && <div className="panel-error">{libraryError}</div>}
            {libraryLoading && !libraryDocuments.length && <div className="finder-status loading"><span />正在读取文档库…</div>}
            {!libraryLoading && !libraryError && !libraryDocuments.length && <div className="finder-empty">
              <span>▤</span><strong>{libraryQuery ? "没有匹配的文档" : "分析过的手册会保存在这里"}</strong>
              <p>{libraryQuery ? "换一个文件名、型号或厂商关键词再试。" : "打开本地 PDF 或从智能找手册导入后，原始文件、文档索引、推荐问题和 AI 对话都会自动缓存。"}</p>
            </div>}
            {libraryDocuments.map((document) => <article className={`library-card ${activeDocumentId === document.id ? "active" : ""}`} key={document.id}>
              <div className="library-card-head"><span>PDF</span><div><strong title={document.file_name}>{document.file_name}</strong><small>{document.part_number || "未识别型号"}{document.manufacturer ? ` · ${document.manufacturer}` : ""}</small></div></div>
              <div className="library-meta"><span>{document.page_count} 页</span><span>{formatFileSize(document.file_size)}</span><span>{document.updated_at}</span></div>
              <div className="library-actions"><button type="button" onClick={() => void openLibraryDocument(document)} disabled={libraryLoading}>{activeDocumentId === document.id ? "重新打开" : "打开"}</button><button type="button" className="danger" onClick={() => void deleteLibraryDocument(document)} disabled={libraryLoading}>删除</button></div>
            </article>)}
          </div>
        </section> : <section className="manual-panel">
          <form className="manual-toolbar" onSubmit={(event) => { event.preventDefault(); void navigateManual(); }}>
            <div className="manual-topline">
              <div className="manual-nav">
                <button type="button" title="后退" disabled={!manualReady} onClick={() => void manualAction("back")}>←</button>
                <button type="button" title="前进" disabled={!manualReady} onClick={() => void manualAction("forward")}>→</button>
                <button type="button" title="刷新" disabled={!manualReady} onClick={() => void manualAction("reload")}>↻</button>
              </div>
              <select aria-label="搜索引擎" value={searchEngine} onChange={(event) => setSearchEngine(event.target.value as SearchEngineId)}>
                {SEARCH_ENGINES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              <button type="button" className="manual-settings" title="模型、搜索和代理设置" onClick={openSettings}>⚙</button>
            </div>
            <div className="manual-address">
              <input aria-label="型号、关键词或网址" value={manualQuery} onChange={(event) => { setManualQuery(event.target.value); setManualError(""); }} placeholder="芯片型号、datasheet 或网页地址" title={manualCurrentUrl} />
              <button className="manual-go" disabled={!manualReady || !manualQuery.trim() || manualBusy}>{manualBusy ? "…" : "前往"}</button>
            </div>
            <button type="button" className="manual-import" disabled={!manualReady || manualImporting} onClick={() => void importManualPdf()}>{manualImporting ? "正在导入…" : "导入当前 PDF"}</button>
          </form>
          <div ref={manualHost} className="manual-webview-host">
            <div className="manual-placeholder"><span>◎</span><strong>{"__TAURI_INTERNALS__" in window ? manualError || "正在启动在线手册…" : "桌面版中显示网页"}</strong><p>网页启动失败不会影响本地 PDF。就绪后可搜索型号，点击 PDF 链接会自动导入阅读器。</p>{"__TAURI_INTERNALS__" in window && <button type="button" onClick={() => void restartManualPanel()}>重试在线手册</button>}</div>
          </div>
          <div className={`manual-status ${manualError ? "error" : ""}`}><span>{manualError || (manualCurrentUrl ? "网页已加载 · PDF 链接可自动导入" : `本地 WebView2 · ${proxyUrl ? "自定义代理" : "系统网络/代理"}`)}</span><i>{manualReady ? "在线" : manualError ? "可重试" : "启动中"}</i></div>
        </section>}
      </aside>
    </section>
    {settings && <div className="modal-backdrop" onMouseDown={() => setSettings(false)}><section className="settings-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head"><div><span className="spark">✦</span><strong>模型与网络设置</strong></div><button onClick={() => setSettings(false)}>×</button></div>
      <p>支持 OpenAI Chat Completions 兼容接口。桌面版可把 API Key 安全保存到 Windows 凭据管理器，不会写入项目、SQLite 或普通设置文件。</p>
      <label>模型服务商</label>
      <div className="provider-picks">{PROVIDERS.map((item) => <button className={provider === item.id ? "active" : ""} key={item.id} onClick={() => chooseProvider(item.id)}>{item.name}</button>)}</div>
      <div className="settings-grid">
        <label>API Key<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settingsRestoring ? "正在恢复已保存密钥…" : "sk-…"} disabled={settingsRestoring || settingsSaving} autoFocus /></label>
        <label>模型<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="模型 ID" /></label>
      </div>
      <div className="credential-options">
        <label className="remember-key"><input type="checkbox" checked={rememberApiKeys} onChange={(event) => setRememberApiKeys(event.target.checked)} disabled={settingsRestoring || settingsSaving} /><span><strong>关闭软件后仍记住 API Key</strong><small>由当前 Windows 用户的系统凭据管理器保护</small></span></label>
        <button type="button" className="clear-credentials" onClick={() => void clearSavedCredentials()} disabled={settingsRestoring || settingsSaving}>清除已保存密钥</button>
      </div>
      <label>API Base URL<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" /></label>
      {!!providerPreset.models.length && <div className="model-picks">{providerPreset.models.map((item) => <button key={item.value} onClick={() => setModel(item.value)}>{item.label}</button>)}</div>}
      <div className="settings-divider" />
      <div className="settings-grid">
        <label>在线手册搜索引擎<select value={searchEngine} onChange={(event) => setSearchEngine(event.target.value as SearchEngineId)}>{SEARCH_ENGINES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>代理（可选）<input value={proxyDraft} onChange={(event) => { setProxyDraft(event.target.value); setNetworkResult(null); }} placeholder="留空使用系统代理，或 127.0.0.1:7890" /></label>
      </div>
      <small className="proxy-help">支持 http:// 与 socks5://。仅浏览器扩展里的代理通常不会传给桌面 WebView2，请填写代理监听地址。</small>
      <div className="network-tools"><button onClick={() => void testNetwork("manual")} disabled={networkTesting}>{networkTesting ? "测试中…" : "测试在线手册"}</button><button onClick={() => void testNetwork("model")} disabled={networkTesting || !baseUrl.trim()}>{networkTesting ? "测试中…" : "测试模型地址"}</button>{networkResult && <span className={networkResult.reachable ? "ok" : "error"}>{networkResult.message}</span>}</div>
      {settingsFeedback && <div className={settingsFeedback.startsWith("已清除") ? "settings-feedback ok" : "settings-feedback error"} role="status">{settingsFeedback}</div>}
      <div className="modal-actions"><button className="secondary" onClick={() => setSettings(false)} disabled={settingsSaving}>取消</button><button className="primary" disabled={settingsRestoring || settingsSaving || !baseUrl.trim() || !model.trim()} onClick={() => void saveSettings()}>{settingsSaving ? "正在安全保存…" : "应用并保存"}</button></div>
    </section></div>}
  </main>;
}
