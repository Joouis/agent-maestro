declare module "vscode" {
  // https://github.com/microsoft/vscode/issues/206265
  export enum LanguageModelChatMessageRole {
    System = 3,
  }
}
