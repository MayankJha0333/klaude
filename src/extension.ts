import * as vscode from "vscode";
import { ChatPanelProvider } from "./ui/panel.js";
import { generateConventionsCommand } from "./commands/init-conventions.js";
import { PermissionMode } from "./core/types.js";

export function activate(ctx: vscode.ExtensionContext) {
  const panel = new ChatPanelProvider(ctx);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanelProvider.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("klaude.newChat", () => panel.newSession()),
    vscode.commands.registerCommand("klaude.toggleChat", () =>
      vscode.commands.executeCommand("workbench.view.extension.klaude")
    ),
    vscode.commands.registerCommand("klaude.cycleMode", async () => {
      const cfg = vscode.workspace.getConfiguration("klaude");
      const order: PermissionMode[] = ["default", "plan", "auto"];
      const cur = cfg.get<PermissionMode>("permissionMode", "default");
      const next = order[(order.indexOf(cur) + 1) % order.length];
      await cfg.update("permissionMode", next, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`Klaude mode: ${next}`, 2000);
    }),
    vscode.commands.registerCommand("klaude.sendSelection", () =>
      panel.sendSelectionToChat()
    ),
    vscode.commands.registerCommand("klaude.commentOnSelection", () =>
      panel.commentOnEditorSelection()
    ),
    vscode.commands.registerCommand("klaude.generateConventions", () =>
      generateConventionsCommand(panel)
    )
  );
}

export function deactivate() {}
