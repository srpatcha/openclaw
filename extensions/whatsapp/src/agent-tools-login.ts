import { Type } from "@sinclair/typebox";
import type { ChannelAgentTool } from "openclaw/plugin-sdk/channel-contract";
import { startWebLoginWithQr, waitForWebLogin } from "../login-qr-api.js";

const DEFAULT_ACCOUNT_KEY = "__default__";
const currentQrDataUrlByAccount = new Map<string, string>();

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getAccountKey(accountId: string | undefined): string {
  return accountId ?? DEFAULT_ACCOUNT_KEY;
}

function shouldClearTrackedQr(params: {
  connected?: boolean;
  message: string;
  qrDataUrl?: string;
}): boolean {
  if (params.connected || !params.qrDataUrl) {
    return (
      params.connected === true ||
      params.message === "No active WhatsApp login in progress." ||
      params.message === "Login ended without a connection." ||
      params.message.startsWith("WhatsApp login failed:") ||
      params.message ===
        "WhatsApp reported the session is logged out. Cleared cached web session; please scan a new QR." ||
      params.message === "The login QR expired. Ask me to generate a new one." ||
      params.message.startsWith("Failed to ")
    );
  }
  return false;
}

export function createWhatsAppLoginTool(): ChannelAgentTool {
  return {
    label: "WhatsApp Login",
    name: "whatsapp_login",
    ownerOnly: true,
    description: "Generate a WhatsApp QR code for linking, or wait for the scan to complete.",
    // NOTE: Using Type.Unsafe for action enum instead of Type.Union([Type.Literal(...)]
    // because Claude API on Vertex AI rejects nested anyOf schemas as invalid JSON Schema.
    parameters: Type.Object({
      action: Type.Unsafe<"start" | "wait">({
        type: "string",
        enum: ["start", "wait"],
      }),
      timeoutMs: Type.Optional(Type.Number()),
      force: Type.Optional(Type.Boolean()),
      accountId: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, args) => {
      const renderQrReply = (params: {
        message: string;
        qrDataUrl: string;
        connected?: boolean;
      }) => {
        const text = [
          params.message,
          "",
          "Open WhatsApp → Linked Devices and scan:",
          "",
          `![whatsapp-qr](${params.qrDataUrl})`,
        ].join("\n");
        return {
          content: [{ type: "text" as const, text }],
          details: {
            connected: params.connected ?? false,
            qr: true,
          },
        };
      };

      const action = (args as { action?: string })?.action ?? "start";
      const accountId = readOptionalString((args as { accountId?: unknown }).accountId);
      const accountKey = getAccountKey(accountId);
      if (action === "wait") {
        const result = await waitForWebLogin({
          accountId,
          timeoutMs:
            typeof (args as { timeoutMs?: unknown }).timeoutMs === "number"
              ? (args as { timeoutMs?: number }).timeoutMs
              : undefined,
          currentQrDataUrl: currentQrDataUrlByAccount.get(accountKey),
        });
        if (result.qrDataUrl) {
          currentQrDataUrlByAccount.set(accountKey, result.qrDataUrl);
          return renderQrReply({
            message: result.message,
            qrDataUrl: result.qrDataUrl,
            connected: result.connected,
          });
        }
        if (shouldClearTrackedQr(result)) {
          currentQrDataUrlByAccount.delete(accountKey);
        }
        return {
          content: [{ type: "text", text: result.message }],
          details: { connected: result.connected },
        };
      }

      const result = await startWebLoginWithQr({
        accountId,
        timeoutMs:
          typeof (args as { timeoutMs?: unknown }).timeoutMs === "number"
            ? (args as { timeoutMs?: number }).timeoutMs
            : undefined,
        force:
          typeof (args as { force?: unknown }).force === "boolean"
            ? (args as { force?: boolean }).force
            : false,
      });

      if (!result.qrDataUrl) {
        currentQrDataUrlByAccount.delete(accountKey);
        return {
          content: [
            {
              type: "text",
              text: result.message,
            },
          ],
          details: { qr: false },
        };
      }

      currentQrDataUrlByAccount.set(accountKey, result.qrDataUrl);
      return renderQrReply({
        message: result.message,
        qrDataUrl: result.qrDataUrl,
        connected: result.connected,
      });
    },
  };
}
