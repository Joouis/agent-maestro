# Roo Code API Provider Configuration

Roo Code supports multiple AI providers through a flexible configuration system. This document covers all provider-specific settings, configuration management, and integration patterns.

## Table of Contents

1. [Provider System Overview](#provider-system-overview)
2. [Supported Providers](#supported-providers)
3. [ProviderSettings Interface](#providersettings-interface)
4. [Provider-Specific Configurations](#provider-specific-configurations)
5. [Profile Management](#profile-management)
6. [Configuration Examples](#configuration-examples)
7. [Model Parameters](#model-parameters)

---

## Provider System Overview

Roo Code's provider system enables seamless integration with multiple AI services through a unified configuration interface. Each provider has specific settings while sharing common configuration options.

### Key Features

- **Multi-provider Support**: 20+ AI providers supported
- **Profile Management**: Named configurations for different use cases
- **Runtime Switching**: Change providers without restart
- **Secret Management**: Secure handling of API keys and tokens
- **Model-specific Settings**: Provider-specific optimizations

### Provider Types

```typescript
type ProviderName =
  | "anthropic" // Anthropic Claude
  | "glama" // Glama API
  | "openrouter" // OpenRouter
  | "bedrock" // AWS Bedrock
  | "vertex" // Google Vertex AI
  | "openai" // OpenAI Compatible APIs
  | "ollama" // Ollama local models
  | "vscode-lm" // VSCode Language Models
  | "lmstudio" // LM Studio
  | "gemini" // Google Gemini
  | "openai-native" // OpenAI Native API
  | "mistral" // Mistral AI
  | "deepseek" // DeepSeek
  | "unbound" // Unbound
  | "requesty" // Requesty
  | "human-relay" // Human-in-the-loop
  | "fake-ai" // Testing/Mock provider
  | "xai" // xAI Grok
  | "groq" // Groq
  | "chutes" // Chutes
  | "litellm" // LiteLLM proxy
  | "minimax"; // MiniMax
```

---

## ProviderSettings Interface

The main configuration interface that combines all provider-specific settings:

```typescript
interface ProviderSettings {
  // Provider Selection
  apiProvider?: ProviderName;

  // Common Settings
  includeMaxTokens?: boolean;
  diffEnabled?: boolean;
  fuzzyMatchThreshold?: number;
  modelTemperature?: number;
  rateLimitSeconds?: number;

  // Model Reasoning (for compatible providers)
  enableReasoningEffort?: boolean;
  reasoningEffort?: "low" | "medium" | "high";
  modelMaxTokens?: number;
  modelMaxThinkingTokens?: number;

  // Provider-specific settings (detailed below)
  // Anthropic
  apiKey?: string;
  apiModelId?: string;
  anthropicBaseUrl?: string;
  anthropicUseAuthToken?: boolean;

  // OpenRouter
  openRouterApiKey?: string;
  openRouterModelId?: string;
  openRouterBaseUrl?: string;
  openRouterSpecificProvider?: string;
  openRouterUseMiddleOutTransform?: boolean;

  // AWS Bedrock
  awsAccessKey?: string;
  awsSecretKey?: string;
  awsSessionToken?: string;
  awsRegion?: string;
  awsUseCrossRegionInference?: boolean;
  awsUsePromptCache?: boolean;
  awsProfile?: string;
  awsUseProfile?: boolean;
  awsCustomArn?: string;
  awsModelContextWindow?: number;
  awsBedrockEndpointEnabled?: boolean;
  awsBedrockEndpoint?: string;

  // ... (all other provider settings)
}
```

---

## Provider-Specific Configurations

### Anthropic Claude

Direct integration with Anthropic's API for Claude models.

```typescript
interface AnthropicSettings {
  apiProvider: "anthropic";
  apiKey: string; // Anthropic API key
  apiModelId?: string; // Model ID (e.g., "claude-3-sonnet-20240229")
  anthropicBaseUrl?: string; // Custom API base URL
  anthropicUseAuthToken?: boolean; // Use auth token instead of API key

  // Common settings
  modelTemperature?: number;
  rateLimitSeconds?: number;
  modelMaxTokens?: number;
}
```

**Example:**

```typescript
const anthropicConfig: AnthropicSettings = {
  apiProvider: "anthropic",
  apiKey: "sk-ant-api03-...",
  apiModelId: "claude-3-opus-20240229",
  modelTemperature: 0.7,
  modelMaxTokens: 4096,
};
```

### OpenRouter

Access to multiple providers through OpenRouter's unified API.

```typescript
interface OpenRouterSettings {
  apiProvider: "openrouter";
  openRouterApiKey: string; // OpenRouter API key
  openRouterModelId?: string; // Model identifier
  openRouterBaseUrl?: string; // Custom base URL
  openRouterSpecificProvider?: string; // Force specific provider
  openRouterUseMiddleOutTransform?: boolean; // Enable middle-out optimization
}
```

**Popular OpenRouter Models:**

- `anthropic/claude-3-opus`
- `openai/gpt-4-turbo`
- `google/gemini-pro-1.5`
- `meta-llama/llama-2-70b-chat`

### AWS Bedrock

Enterprise-grade AI through AWS Bedrock service.

```typescript
interface BedrockSettings {
  apiProvider: "bedrock";
  apiModelId?: string; // Bedrock model ID
  awsAccessKey?: string; // AWS access key
  awsSecretKey?: string; // AWS secret key
  awsSessionToken?: string; // Session token (for temporary credentials)
  awsRegion?: string; // AWS region
  awsUseCrossRegionInference?: boolean; // Enable cross-region inference
  awsUsePromptCache?: boolean; // Use prompt caching
  awsProfile?: string; // AWS profile name
  awsUseProfile?: boolean; // Use AWS profile instead of keys
  awsCustomArn?: string; // Custom model ARN
  awsModelContextWindow?: number; // Custom context window size
  awsBedrockEndpointEnabled?: boolean; // Use custom endpoint
  awsBedrockEndpoint?: string; // Custom endpoint URL
}
```

**Supported Bedrock Models:**

- `anthropic.claude-3-sonnet-20240229-v1:0`
- `anthropic.claude-3-opus-20240229-v1:0`
- `anthropic.claude-3-haiku-20240307-v1:0`

### Google Vertex AI

Google's enterprise AI platform.

```typescript
interface VertexSettings {
  apiProvider: "vertex";
  apiModelId?: string; // Vertex model ID
  vertexKeyFile?: string; // Path to service account key file
  vertexJsonCredentials?: string; // JSON credentials as string
  vertexProjectId?: string; // GCP project ID
  vertexRegion?: string; // GCP region
}
```

### OpenAI Compatible

Generic OpenAI-compatible API support for various providers.

```typescript
interface OpenAISettings {
  apiProvider: "openai";
  openAiBaseUrl?: string; // API base URL
  openAiApiKey?: string; // API key
  openAiLegacyFormat?: boolean; // Use legacy API format
  openAiR1FormatEnabled?: boolean; // Enable R1 format
  openAiModelId?: string; // Model identifier
  openAiCustomModelInfo?: ModelInfo; // Custom model capabilities
  openAiUseAzure?: boolean; // Use Azure OpenAI
  azureApiVersion?: string; // Azure API version
  openAiStreamingEnabled?: boolean; // Enable streaming responses
  openAiHeaders?: Record<string, string>; // Custom headers
}
```

### Ollama (Local Models)

Run models locally with Ollama.

```typescript
interface OllamaSettings {
  apiProvider: "ollama";
  ollamaModelId?: string; // Local model name
  ollamaBaseUrl?: string; // Ollama server URL (default: http://localhost:11434)
}
```

**Example:**

```typescript
const ollamaConfig: OllamaSettings = {
  apiProvider: "ollama",
  ollamaModelId: "llama2:13b",
  ollamaBaseUrl: "http://localhost:11434",
};
```

### LM Studio

Local inference with LM Studio.

```typescript
interface LMStudioSettings {
  apiProvider: "lmstudio";
  lmStudioModelId?: string; // Model identifier
  lmStudioBaseUrl?: string; // LM Studio server URL
  lmStudioDraftModelId?: string; // Draft model for speculative decoding
  lmStudioSpeculativeDecodingEnabled?: boolean; // Enable speculative decoding
}
```

### VSCode Language Models

Use VSCode's built-in language model API.

```typescript
interface VSCodeLMSettings {
  apiProvider: "vscode-lm";
  vsCodeLmModelSelector?: {
    vendor?: string; // Model vendor
    family?: string; // Model family
    version?: string; // Model version
    id?: string; // Specific model ID
  };
}
```

---

## Profile Management

Profiles allow saving and switching between different provider configurations.

### Profile Structure

```typescript
interface ProviderSettingsEntry {
  id: string; // Unique profile identifier
  name: string; // Human-readable profile name
  apiProvider?: ProviderName; // Associated provider
}
```

### Profile Operations

#### Creating Profiles

```typescript
// Create a development profile with Anthropic
await api.createProfile(
  "development",
  {
    apiProvider: "anthropic",
    apiKey: "sk-ant-api03-...",
    apiModelId: "claude-3-sonnet-20240229",
    modelTemperature: 0.3,
    rateLimitSeconds: 1,
  },
  true,
); // Activate immediately

// Create a production profile with OpenRouter
await api.createProfile("production", {
  apiProvider: "openrouter",
  openRouterApiKey: "sk-or-...",
  openRouterModelId: "anthropic/claude-3-opus",
  modelTemperature: 0.7,
  rateLimitSeconds: 5,
});
```

#### Managing Profiles

```typescript
// List all available profiles
const profiles = api.getProfiles();
console.log("Available profiles:", profiles);

// Get specific profile details
const devProfile = api.getProfileEntry("development");
if (devProfile) {
  console.log("Dev profile:", devProfile);
}

// Switch active profile
await api.setActiveProfile("production");

// Update existing profile
await api.updateProfile("development", {
  apiModelId: "claude-3-opus-20240229", // Upgrade to Opus
  modelMaxTokens: 8192,
});

// Delete unused profile
await api.deleteProfile("old-profile");
```

---

## Configuration Examples

### Multi-Environment Setup

```typescript
// Development environment - fast, cheap model
const devConfig = {
  apiProvider: "openrouter" as const,
  openRouterApiKey: process.env.OPENROUTER_API_KEY,
  openRouterModelId: "anthropic/claude-3-haiku",
  modelTemperature: 0.3,
  rateLimitSeconds: 0,
  autoApprovalEnabled: true,
};

// Production environment - high-quality model
const prodConfig = {
  apiProvider: "anthropic" as const,
  apiKey: process.env.ANTHROPIC_API_KEY,
  apiModelId: "claude-3-opus-20240229",
  modelTemperature: 0.7,
  rateLimitSeconds: 2,
  autoApprovalEnabled: false,
};

// Testing environment - local model
const testConfig = {
  apiProvider: "ollama" as const,
  ollamaModelId: "llama2:7b",
  ollamaBaseUrl: "http://localhost:11434",
  rateLimitSeconds: 0,
};
```

### Cost-Optimized Configuration

```typescript
const costOptimizedConfig = {
  // Use cheaper models for different tasks
  apiProvider: "openrouter" as const,
  openRouterApiKey: process.env.OPENROUTER_API_KEY,

  // Primary model for complex tasks
  openRouterModelId: "anthropic/claude-3-sonnet",

  // Condensing configuration for cheaper summarization
  condensingApiConfigId: "haiku-profile", // Separate profile with Haiku

  // Context management to reduce token usage
  autoCondenseContext: true,
  autoCondenseContextPercent: 80,
  maxOpenTabsContext: 10,
  maxWorkspaceFiles: 100,

  // Rate limiting to control costs
  rateLimitSeconds: 3,
  allowedMaxRequests: 50,

  // Disable expensive features
  enableReasoningEffort: false,
  modelMaxTokens: 4096,
};
```

### High-Performance Configuration

```typescript
const highPerformanceConfig = {
  apiProvider: "anthropic" as const,
  apiKey: process.env.ANTHROPIC_API_KEY,
  apiModelId: "claude-3-opus-20240229",

  // Maximum quality settings
  modelTemperature: 0.8,
  modelMaxTokens: 8192,
  enableReasoningEffort: true,
  reasoningEffort: "high" as const,

  // Fast response settings
  rateLimitSeconds: 0,
  requestDelaySeconds: 0,

  // Auto-approval for speed
  autoApprovalEnabled: true,
  alwaysAllowReadOnly: true,
  alwaysAllowWrite: true,
  alwaysAllowExecute: true,

  // Rich context
  maxConcurrentFileReads: 100,
  maxOpenTabsContext: 50,
  maxWorkspaceFiles: 500,
};
```

### Enterprise Configuration

```typescript
const enterpriseConfig = {
  // Use AWS Bedrock for compliance
  apiProvider: "bedrock" as const,
  apiModelId: "anthropic.claude-3-sonnet-20240229-v1:0",
  awsRegion: "us-east-1",
  awsUseProfile: true,
  awsProfile: "production",
  awsUsePromptCache: true,

  // Security settings
  autoApprovalEnabled: false,
  alwaysAllowReadOnly: false,
  alwaysAllowWrite: false,
  alwaysAllowExecute: false,

  // Audit and compliance
  enableCheckpoints: true,
  diffEnabled: true,

  // Performance limits
  rateLimitSeconds: 5,
  allowedMaxRequests: 100,
  terminalOutputLineLimit: 1000,
  maxReadFileLine: 10000,
};
```

---

## Model Parameters

### Common Parameters

All providers support these common configuration options:

```typescript
interface CommonModelParams {
  modelTemperature?: number; // Creativity/randomness (0.0-2.0)
  rateLimitSeconds?: number; // Minimum seconds between requests
  modelMaxTokens?: number; // Maximum tokens in response
  includeMaxTokens?: boolean; // Include max_tokens in API requests
  diffEnabled?: boolean; // Enable diff-based responses
  fuzzyMatchThreshold?: number; // Fuzzy matching sensitivity
}
```

### Reasoning Parameters

For models that support reasoning (like Claude and o1):

```typescript
interface ReasoningParams {
  enableReasoningEffort?: boolean; // Enable reasoning optimization
  reasoningEffort?: "low" | "medium" | "high"; // Reasoning intensity
  modelMaxThinkingTokens?: number; // Max tokens for internal reasoning
}
```

### Model Information Schema

For custom or unknown models, you can specify capabilities:

```typescript
interface ModelInfo {
  maxTokens?: number; // Maximum output tokens
  maxThinkingTokens?: number; // Maximum reasoning tokens
  contextWindow: number; // Total context window size
  supportsImages?: boolean; // Image input support
  supportsComputerUse?: boolean; // Computer use capabilities
  supportsPromptCache?: boolean; // Prompt caching support
  supportsReasoningBudget?: boolean; // Reasoning budget control
  requiredReasoningBudget?: boolean; // Reasoning budget required
  supportsReasoningEffort?: boolean; // Reasoning effort control
  supportedParameters?: ModelParameter[]; // Supported parameters
  inputPrice?: number; // Price per input token
  outputPrice?: number; // Price per output token
  cacheWritesPrice?: number; // Cache write price
  cacheReadsPrice?: number; // Cache read price
  description?: string; // Model description
}
```

### Provider-Specific Features

#### Anthropic Features

- **Prompt Caching**: Reduce costs for repeated prompts
- **Computer Use**: Interact with desktop applications
- **Vision**: Analyze images and screenshots

#### OpenRouter Features

- **Provider Selection**: Force specific underlying provider
- **Middle-out Transform**: Optimize for certain use cases
- **Fallback Models**: Automatic failover between models

#### AWS Bedrock Features

- **Cross-region Inference**: Route to different regions
- **Custom Endpoints**: Use private endpoints
- **IAM Integration**: Fine-grained access control

#### Local Model Features (Ollama/LM Studio)

- **Offline Operation**: No internet required
- **Custom Models**: Load your own fine-tuned models
- **Hardware Optimization**: GPU acceleration support

This comprehensive provider system enables flexible, scalable AI integration tailored to specific use cases and requirements.
