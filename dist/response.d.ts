type ResponseOptions = {
    readonly toolNameMap?: Readonly<Record<string, string>>;
};
export declare const streamAnthropicSse: (response: Response, options?: ResponseOptions) => Response;
export declare const adaptAnthropicResponse: (response: Response, options?: ResponseOptions) => Promise<Response>;
export declare const convertAnthropicResponseToSse: (response: Response, options?: ResponseOptions) => Promise<Response>;
export {};
