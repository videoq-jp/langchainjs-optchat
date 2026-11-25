/** Provider-independent image content used by the memory engine. */
export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}
