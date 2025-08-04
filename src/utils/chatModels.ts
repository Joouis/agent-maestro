import * as vscode from "vscode";
import { waitFor } from "./waitFor";

const chatModelToQuickPickItem = (model: vscode.LanguageModelChat) => ({
  label: model.name,
  description: `${model.vendor} - ${model.id}`,
  modelId: model.id,
});

export const getChatModelsQuickPickItems = async () => {
  // Get available models from VS Code LM API
  let allModels = await vscode.lm.selectChatModels({});
  if (allModels.length === 0) {
    try {
      await waitFor(async () => {
        allModels = await vscode.lm.selectChatModels({});
        return allModels.length > 0;
      });
    } catch {
      vscode.window.showErrorMessage(
        "No available model provided by VS Code LM API.",
      );
      return;
    }
  }

  const claudeModels = [];
  const geminiModels = [];
  const restModels = [];
  for (const m of allModels) {
    if (m.id.toLocaleLowerCase().includes("claude")) {
      claudeModels.push(m);
    } else if (m.id.toLocaleLowerCase().includes("gemini")) {
      geminiModels.push(m);
    } else {
      restModels.push(m);
    }
  }

  // Show model selection for ANTHROPIC_MODEL
  const modelOptions = [
    {
      kind: vscode.QuickPickItemKind.Separator,
      label: "Claude",
      modelId: "",
    },
    ...claudeModels.map(chatModelToQuickPickItem),
    {
      kind: vscode.QuickPickItemKind.Separator,
      label: "OpenAI",
      modelId: "",
    },
    ...restModels.map(chatModelToQuickPickItem),
    {
      kind: vscode.QuickPickItemKind.Separator,
      label: "Gemini",
      modelId: "",
    },
    ...geminiModels.map(chatModelToQuickPickItem),
  ];

  return modelOptions;
};
