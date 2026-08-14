/// <reference lib="webworker" />

type SerializeRequest = {
  action: "serialize";
  buffer: ArrayBuffer;
  blocks: unknown[];
  searchLines: unknown[];
  pageSizes: unknown[];
  questions: string[];
};
type DecodeRequest = { action: "decode"; dataBase64: string };
type RestoreRequest = {
  action: "restore";
  dataBase64: string;
  blocksJson: string;
  searchLinesJson: string;
  pageSizesJson: string;
  questionsJson: string;
  messagesJson: string;
};
type CacheRequest = SerializeRequest | DecodeRequest | RestoreRequest;

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

const decodeBase64 = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
};

const parseOr = <T,>(value: string, fallback: T): T => {
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

workerScope.onmessage = (event: MessageEvent<CacheRequest>) => {
  if (event.data.action === "decode") {
    const buffer = decodeBase64(event.data.dataBase64);
    workerScope.postMessage({ buffer }, [buffer]);
    return;
  }
  if (event.data.action === "restore") {
    const buffer = decodeBase64(event.data.dataBase64);
    workerScope.postMessage({
      buffer,
      blocks: parseOr(event.data.blocksJson, []),
      searchLines: parseOr(event.data.searchLinesJson, []),
      pageSizes: parseOr(event.data.pageSizesJson, []),
      questions: parseOr(event.data.questionsJson, []),
      messages: parseOr(event.data.messagesJson, []),
    }, [buffer]);
    return;
  }

  const bytes = new Uint8Array(event.data.buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  workerScope.postMessage({
    data_base64: btoa(binary),
    blocks_json: JSON.stringify(event.data.blocks),
    search_lines_json: JSON.stringify(event.data.searchLines),
    page_sizes_json: JSON.stringify(event.data.pageSizes),
    questions_json: JSON.stringify(event.data.questions),
  });
};

export {};
