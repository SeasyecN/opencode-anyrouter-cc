type ResponseOptions = {
    readonly toolNameMap?: Readonly<Record<string, string>>;
};
export declare const convertAnthropicResponseToSse: (response: Response, options?: ResponseOptions) => Promise<Response>;
export {};
