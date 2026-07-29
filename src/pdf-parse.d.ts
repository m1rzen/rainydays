// pdf-parse 没有自带类型声明，这里补一个
declare module "pdf-parse" {
  interface PdfData {
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: Record<string, unknown>;
    text: string;
    version: string;
  }

  interface PdfParse {
    (dataBuffer: Buffer): Promise<PdfData>;
    default?: PdfParse;
  }

  const pdfParse: PdfParse;
  export default pdfParse;
}
