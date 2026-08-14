export interface BoundingBox { x: number; y: number; width: number; height: number }
export interface TextBlock { page: number; text: string; bbox: BoundingBox }
export interface DocumentSource extends TextBlock { score?: number }
export interface AIResponse {
  answer: string;
  sources: DocumentSource[];
  action?: "none" | "goto" | "highlight" | "zoom";
}
export interface ViewerController {
  gotoPage(page: number): void;
  setZoom(scale: number): void;
  highlightRegion(page: number, bbox: BoundingBox): void;
  zoomToRegion(page: number, bbox: BoundingBox): void;
  clearHighlights(): void;
}
