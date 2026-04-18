#!/usr/bin/env node

import path from "node:path";
/**
 * Lint: 运行时代码不得导入 config redact/restore 模块
 *
 * OpenClaw 的配置读写存在两条独立路径，不可混用：
 *
 * 1. Runtime path: loadConfig() → 直接使用原始值（浏览器连接、embedding 调用等）
 * 2. API/Display path: readConfigFileSnapshot() → redactConfigSnapshot() → 返回给 UI
 *    写入时: restoreRedactedValues() 还原 __OPENCLAW_REDACTED__ 占位符
 *
 * 运行时代码如果意外使用了 redacted 值（如浏览器连接拿到 __OPENCLAW_REDACTED__），
 * 会导致连接失败；展示代码如果漏做 redact，会泄露凭据。
 *
 * 此规则确保运行时目录不导入 redact-snapshot 中的 redact/restore 函数，
 * 防止两条路径被意外混用。
 *
 * 注意：redactSensitiveUrl() / redactSensitiveUrlLikeString() 在运行时代码中
 * 用于日志/错误消息的 URL 脱敏是合理使用，不被此规则禁止。
 */
import ts from "typescript";
import { runCallsiteGuard } from "./lib/callsite-guard.mjs";
import { resolveRepoRoot, runAsScript } from "./lib/ts-guard-utils.mjs";

/**
 * Scan the repo-wide production surface instead of trying to enumerate every
 * runtime directory. Redacted config helpers should only be imported from a
 * small set of display/config surfaces; everything else is treated as runtime.
 */
const SOURCE_ROOTS = ["src", "extensions", "apps"];

/**
 * Only config display/writeback surfaces may import redact-snapshot helpers.
 */
const ALLOWED_REDACT_SNAPSHOT_CALLSITES = new Set([
  "src/cli/config-cli.ts",
  "src/gateway/server-methods/config.ts",
  "src/gateway/server-methods/talk.ts",
]);

/**
 * Only config metadata/redaction internals may import these schema helpers.
 */
const ALLOWED_REDACT_SENSITIVE_URL_CALLSITES = new Set([
  "src/config/redact-snapshot.ts",
  "src/config/schema-base.ts",
  "src/config/schema.hints.ts",
]);
const REPO_ROOT = resolveRepoRoot(import.meta.url);

const BANNED_FROM_REDACT_SNAPSHOT = new Set([
  "redactConfigSnapshot", // 替换整个 snapshot 中的敏感字段
  "redactConfigObject", // 替换 config 对象中的敏感字段
  "restoreRedactedValues", // 将 __OPENCLAW_REDACTED__ 还原为原始值
  "REDACTED_SENTINEL", // sentinel 常量
]);

/**
 * 从 redact-sensitive-url 导入时，被禁止的符号。
 *
 * redactSensitiveUrl() / redactSensitiveUrlLikeString() 不在禁止列表中 —
 * 它们在运行时代码中用于日志/错误消息的 URL 脱敏，是合理的。
 *
 * 以下函数仅用于 config redact 框架内部，运行时代码不应依赖：
 */
const BANNED_FROM_REDACT_SENSITIVE_URL = new Set([
  "isSensitiveUrlConfigPath", // 判断配置路径是否为敏感 URL — 仅 config redact 框架需要
  "hasSensitiveUrlHintTag", // 检查 url-secret 标签 — 仅 config redact 框架需要
  "SENSITIVE_URL_HINT_TAG", // url-secret 常量 — 仅 config redact 框架需要
]);

function findViolations(content, filePath) {
  const relativePath = path.relative(REPO_ROOT, filePath).replaceAll(path.sep, "/");
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const violations = [];

  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (!ts.isStringLiteral(moduleSpecifier)) {
        ts.forEachChild(node, visit);
        return;
      }

      const importPath = moduleSpecifier.text;

      const isRedactSnapshotImport = importPath.includes("redact-snapshot");
      const isRedactSensitiveUrlImport = importPath.includes("redact-sensitive-url");

      if (!isRedactSnapshotImport && !isRedactSensitiveUrlImport) {
        return;
      }

      const allowedCallsites = isRedactSnapshotImport
        ? ALLOWED_REDACT_SNAPSHOT_CALLSITES
        : ALLOWED_REDACT_SENSITIVE_URL_CALLSITES;
      if (allowedCallsites.has(relativePath)) {
        return;
      }

      const bannedImports = isRedactSnapshotImport
        ? BANNED_FROM_REDACT_SNAPSHOT
        : BANNED_FROM_REDACT_SENSITIVE_URL;

      const importClause = node.importClause;
      if (!importClause) {
        return;
      }

      // Named imports: import { a, b } from "..."
      if (importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
        for (const element of importClause.namedBindings.elements) {
          if (bannedImports.has(element.name.text)) {
            const line = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile));
            violations.push(line.line + 1);
          }
        }
      }

      // Namespace import: import * as X from "..."
      if (importClause.namedBindings && ts.isNamespaceImport(importClause.namedBindings)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push(line.line + 1);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

runAsScript(import.meta.url, async () => {
  await runCallsiteGuard({
    sourceRoots: SOURCE_ROOTS,
    header: [
      "Config redact/restore functions must only be imported in approved display/config code.",
      "",
      "Any code that executes with live config must use loadConfig() directly.",
      "Redact/restore helpers are only for config display/writeback flows.",
      "",
      "Banned from redact-snapshot: redactConfigSnapshot, redactConfigObject,",
      "  restoreRedactedValues, REDACTED_SENTINEL",
      "Banned from redact-sensitive-url: isSensitiveUrlConfigPath,",
      "  hasSensitiveUrlHintTag, SENSITIVE_URL_HINT_TAG",
      "",
      "Allowed in runtime: redactSensitiveUrl, redactSensitiveUrlLikeString",
      "  (for log/error URL redaction — this is legitimate runtime usage)",
      "",
      "Only these files may import redact-snapshot helpers:",
      ...Array.from(ALLOWED_REDACT_SNAPSHOT_CALLSITES).map((path) => `  - ${path}`),
      "Only these files may import config-path/url-hint helpers:",
      ...Array.from(ALLOWED_REDACT_SENSITIVE_URL_CALLSITES).map((path) => `  - ${path}`),
      "",
      "Violations:",
    ].join("\n"),
    footer: ["", "See: my_docs/04-cases/2026-04-18-config-read-write-dual-path/00-README.md"].join(
      "\n",
    ),
    findCallLines: findViolations,
    importMetaUrl: import.meta.url,
    sortViolations: true,
    allowCallsite: () => false,
    skipRelativePath: (relPath) => {
      if (relPath.includes(".test.") || relPath.includes(".spec.")) {
        return true;
      }
      if (relPath.includes("/test-helpers/")) {
        return true;
      }
      if (relPath.endsWith(".test-helpers.ts")) {
        return true;
      }
      if (relPath.endsWith(".d.ts")) {
        return true;
      }
      return false;
    },
  });
});
