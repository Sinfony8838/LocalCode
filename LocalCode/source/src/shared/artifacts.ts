export type ArtifactKind = 'html' | 'image' | 'pdf' | 'text' | 'binary';
export type ArtifactAction = 'open' | 'choose-app' | 'reveal' | 'copy-path';
/** Filesystem paths are literal; only URI/Markdown references are decoded. */
export type ArtifactInputKind = 'path' | 'reference';
export interface ArtifactInfo {
  path: string;
  absolutePath: string;
  name: string;
  kind: ArtifactKind;
  previewUrl?: string;
  canOpenExternally: boolean;
  size: number;
}
