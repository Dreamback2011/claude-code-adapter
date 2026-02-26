import type { Request, Response, NextFunction } from "express";

/**
 * API Key authentication middleware.
 * Checks x-api-key header or Authorization: Bearer <key>.
 */
export function createAuthMiddleware(apiKey: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip auth if no key is configured
    if (!apiKey) {
      next();
      return;
    }

    const key =
      req.headers["x-api-key"] as string ||
      extractBearerToken(req.headers.authorization);

    if (!key || key !== apiKey) {
      res.status(401).json({
        type: "error",
        error: {
          type: "authentication_error",
          message: "Invalid API key",
        },
      });
      return;
    }

    next();
  };
}

function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}
