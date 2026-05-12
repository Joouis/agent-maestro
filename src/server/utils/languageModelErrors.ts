export const isTokenLengthErrorLike = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("Response too long");
