import type { JsonRecord } from "./request-shape";
export declare const traceRequest: (entry: {
    readonly body: JsonRecord;
    readonly status: number;
    readonly elapsedMs: number;
    readonly responseBody?: string | undefined;
    readonly contentType?: string | null;
}) => Promise<void>;
