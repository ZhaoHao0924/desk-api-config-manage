import type { ApiConfig, SnippetFormat } from "../types";

export const snippetFormatLabels: Record<SnippetFormat, string> = {
  cmd: "CMD",
  curl: "curl",
  env: ".env",
  node: "Node.js SDK",
  powershell: "PowerShell",
  python: "Python SDK"
};

export interface GeneratedConfigSnippet {
  content: string;
  description: string;
  fileName: string;
  format: SnippetFormat;
  language: "batch" | "env" | "javascript" | "powershell" | "python" | "shell";
  title: string;
}

function getSnippetApiKeyValue(config: ApiConfig): string {
  const preview = config.apiKeyPreview.trim();

  return preview && preview !== "未设置" ? preview : "<API_KEY>";
}

function getChatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function getResponsesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/responses`;
}

function usesResponsesApi(config: ApiConfig): boolean {
  return config.endpointMode === "responses";
}

function quoteJson(value: string): string {
  return JSON.stringify(value);
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function formatDotEnvValue(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : quoteJson(value);
}

function createEnvSnippet(config: ApiConfig): GeneratedConfigSnippet {
  return {
    content: `LLM_API_KEY=${formatDotEnvValue(getSnippetApiKeyValue(config))}
LLM_BASE_URL=${formatDotEnvValue(config.baseUrl)}
LLM_MODEL=${formatDotEnvValue(config.defaultModel)}`,
    description: "写入项目环境变量文件；API Key 使用掩码或占位值，避免暴露完整密钥。",
    fileName: ".env",
    format: "env",
    language: "env",
    title: ".env"
  };
}

function createPowerShellSnippet(config: ApiConfig): GeneratedConfigSnippet {
  const endpointUrl = usesResponsesApi(config) ? getResponsesUrl(config.baseUrl) : getChatCompletionsUrl(config.baseUrl);
  const body = usesResponsesApi(config)
    ? `@{
  model = ${quotePowerShell(config.defaultModel)}
  input = 'Hello'
}`
    : `@{
  model = ${quotePowerShell(config.defaultModel)}
  messages = @(
    @{
      role = 'user'
      content = 'Hello'
    }
  )
}`;

  return {
    content: `$headers = @{
  'Authorization' = 'Bearer ${getSnippetApiKeyValue(config)}'
  'Content-Type' = 'application/json'
}

$body = ${body} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Method Post -Uri ${quotePowerShell(endpointUrl)} -Headers $headers -Body $body`,
    description: "用于 Windows PowerShell 直接发起一次测试请求；完整密钥需在本地替换。",
    fileName: "request.ps1",
    format: "powershell",
    language: "powershell",
    title: "PowerShell"
  };
}

function createCmdSnippet(config: ApiConfig): GeneratedConfigSnippet {
  const endpointPath = usesResponsesApi(config) ? "responses" : "chat/completions";
  const body = usesResponsesApi(config)
    ? `"{""model"":""%LLM_MODEL%"",""input"":""Hello""}"`
    : `"{""model"":""%LLM_MODEL%"",""messages"":[{""role"":""user"",""content"":""Hello""}]}"`;

  return {
    content: `set "LLM_API_KEY=${getSnippetApiKeyValue(config)}"
set "LLM_BASE_URL=${config.baseUrl.replace(/\/+$/, "")}"
set "LLM_MODEL=${config.defaultModel}"

curl.exe "%LLM_BASE_URL%/${endpointPath}" ^
  -H "Authorization: Bearer %LLM_API_KEY%" ^
  -H "Content-Type: application/json" ^
  -d ${body}`,
    description: "用于 Windows CMD 设置临时环境变量并发起一次请求；完整密钥需在本地替换。",
    fileName: "request.cmd",
    format: "cmd",
    language: "batch",
    title: "CMD"
  };
}

function createCurlSnippet(config: ApiConfig): GeneratedConfigSnippet {
  const endpointUrl = usesResponsesApi(config) ? getResponsesUrl(config.baseUrl) : getChatCompletionsUrl(config.baseUrl);
  const body = usesResponsesApi(config)
    ? {
        input: "Hello",
        model: config.defaultModel
      }
    : {
        messages: [
          {
            content: "Hello",
            role: "user"
          }
        ],
        model: config.defaultModel
      };

  return {
    content: `curl.exe ${quoteJson(endpointUrl)} ^
  -H ${quoteJson(`Authorization: Bearer ${getSnippetApiKeyValue(config)}`)} ^
  -H "Content-Type: application/json" ^
  -d ${quoteJson(JSON.stringify(body))}`,
    description: "用于 curl.exe 的最小请求示例；完整密钥需在本地替换。",
    fileName: "request.curl",
    format: "curl",
    language: "shell",
    title: "curl"
  };
}

function createPythonSnippet(config: ApiConfig): GeneratedConfigSnippet {
  const request = usesResponsesApi(config)
    ? `response = client.responses.create(
    model=os.environ["LLM_MODEL"],
    input="Hello",
)

print(response.output_text or "")`
    : `response = client.chat.completions.create(
    model=os.environ["LLM_MODEL"],
    messages=[{"role": "user", "content": "Hello"}],
)

print(response.choices[0].message.content or "")`;

  return {
    content: `import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["LLM_API_KEY"],
    base_url=os.environ["LLM_BASE_URL"],
)

${request}`,
    description: "用于 OpenAI Python SDK；先把 .env 中的三个变量加载到环境中。",
    fileName: "openai_client.py",
    format: "python",
    language: "python",
    title: "Python OpenAI SDK"
  };
}

function createNodeSnippet(config: ApiConfig): GeneratedConfigSnippet {
  const request = usesResponsesApi(config)
    ? `const response = await client.responses.create({
  model: process.env.LLM_MODEL,
  input: "Hello"
});

process.stdout.write(response.output_text ?? "");`
    : `const response = await client.chat.completions.create({
  model: process.env.LLM_MODEL,
  messages: [{ role: "user", content: "Hello" }]
});

process.stdout.write(response.choices[0]?.message?.content ?? "");`;

  return {
    content: `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.LLM_API_KEY,
  baseURL: process.env.LLM_BASE_URL
});

${request}`,
    description: "用于 OpenAI Node.js SDK；先把 .env 中的三个变量加载到环境中。",
    fileName: "openai-client.mjs",
    format: "node",
    language: "javascript",
    title: "Node.js OpenAI SDK"
  };
}

export function createConfigSnippet(format: SnippetFormat, config: ApiConfig): GeneratedConfigSnippet {
  if (format === "powershell") {
    return createPowerShellSnippet(config);
  }

  if (format === "cmd") {
    return createCmdSnippet(config);
  }

  if (format === "curl") {
    return createCurlSnippet(config);
  }

  if (format === "python") {
    return createPythonSnippet(config);
  }

  if (format === "node") {
    return createNodeSnippet(config);
  }

  return createEnvSnippet(config);
}

