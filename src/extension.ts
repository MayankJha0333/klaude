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
    vscode.commands.registerCommand("iridescent.newChat", () => panel.newSession()),
    vscode.commands.registerCommand("iridescent.toggleChat", () =>
      vscode.commands.executeCommand("workbench.view.extension.iridescent")
    ),
    vscode.commands.registerCommand("iridescent.cycleMode", async () => {
      const cfg = vscode.workspace.getConfiguration("iridescent");
      const order: PermissionMode[] = ["default", "plan", "auto"];
      const cur = cfg.get<PermissionMode>("permissionMode", "default");
      const next = order[(order.indexOf(cur) + 1) % order.length];
      await cfg.update("permissionMode", next, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`Iridescent mode: ${next}`, 2000);
    }),
    vscode.commands.registerCommand("iridescent.sendSelection", () =>
      panel.sendSelectionToChat()
    ),
    vscode.commands.registerCommand("iridescent.commentOnSelection", () =>
      panel.commentOnEditorSelection()
    ),
    vscode.commands.registerCommand("iridescent.generateConventions", () =>
      generateConventionsCommand(panel)
    )
  );
}

export function deactivate() {}
