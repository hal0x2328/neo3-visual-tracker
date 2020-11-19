import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import ActiveConnection from "../activeConnection";
import AutoComplete from "../autoComplete";
import AutoCompleteData from "../../shared/autoCompleteData";
import dedupeAndSort from "../dedupeAndSort";
import InvokeFileViewRequest from "../../shared/messages/invokeFileViewRequest";
import InvokeFileViewState from "../../shared/viewState/invokeFileViewState";
import IoHelpers from "../ioHelpers";
import JSONC from "../JSONC";
import NeoExpress from "../neoExpress/neoExpress";
import PanelControllerBase from "./panelControllerBase";
import TransactionStatus from "../../shared/transactionStatus";

const LOG_PREFIX = "[InvokeFilePanelController]";
const MAX_RECENT_TXS = 10;
const REFRESH_INTERVAL_MS = 1000 * 5; // TODO: Use an event instead of polling

export default class InvokeFilePanelController extends PanelControllerBase<
  InvokeFileViewState,
  InvokeFileViewRequest
> {
  private changeWatcher: vscode.Disposable | null;

  constructor(
    context: vscode.ExtensionContext,
    private readonly neoExpress: NeoExpress,
    private readonly document: vscode.TextDocument,
    private readonly activeConnection: ActiveConnection,
    private readonly autoComplete: AutoComplete,
    private readonly panel: vscode.WebviewPanel
  ) {
    super(
      {
        view: "invokeFile",
        panelTitle: "Invoke File Editor",
        fileContents: [],
        autoCompleteData: autoComplete.data,
        errorText: "",
        recentTransactions: [],
        collapseTransactions: true,
        selectedTransactionId: null,
      },
      context,
      panel
    );
    this.onFileUpdate();
    this.changeWatcher = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        this.onFileUpdate();
      }
    });
    this.refreshLoop();
  }

  onClose() {
    if (this.changeWatcher) {
      this.changeWatcher.dispose();
      this.changeWatcher = null;
    }
  }

  protected async onRequest(request: InvokeFileViewRequest) {
    if (request.close) {
      this.panel.dispose();
    }
    if (request.update !== undefined) {
      let newFileContents = [...this.viewState.fileContents];
      newFileContents = newFileContents.map((invocation, i) => {
        if (i === request.update?.i) {
          return {
            contract: request.update.contract,
            operation: request.update.operation,
            args: request.update.args,
          };
        } else {
          return invocation;
        }
      });
      await this.applyEdit(newFileContents);
    }
    if (request.addStep) {
      let newFileContents = [...this.viewState.fileContents];
      newFileContents.push({});
      await this.applyEdit(newFileContents);
    }
    if (request.deleteStep) {
      let newFileContents = this.viewState.fileContents.filter(
        (_, i) => i !== request.deleteStep?.i
      );
      await this.applyEdit(newFileContents);
    }
    if (request.moveStep) {
      let { from, to } = request.moveStep;
      let oldFileContents = [...this.viewState.fileContents];
      let newFileContents = oldFileContents.filter((_, i) => i !== from);
      if (to > from) {
        to--;
      }
      newFileContents = [
        ...newFileContents.filter((_, i) => i < to),
        oldFileContents[from],
        ...newFileContents.filter((_, i) => i >= to),
      ];
      await this.applyEdit(newFileContents);
    }
    if (request.runAll) {
      await this.runFile(this.document.uri.fsPath);
    }
    if (request.runStep) {
      await this.runFragment(this.viewState.fileContents[request.runStep.i]);
    }
    if (request.toggleTransactions) {
      this.updateViewState({
        collapseTransactions: !this.viewState.collapseTransactions,
      });
    }
    if (request.selectTransaction) {
      this.updateViewState({
        selectedTransactionId: request.selectTransaction.txid,
      });
    }
  }

  private async applyEdit(newFileContents: any) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      this.document.uri,
      new vscode.Range(0, 0, this.document.lineCount, 0),
      JSON.stringify(newFileContents, undefined, 2)
    );
    await vscode.workspace.applyEdit(edit);
  }

  private async augmentAutoCompleteData(
    data: AutoCompleteData
  ): Promise<AutoCompleteData> {
    const result = { ...data };
    result.contractPaths = { ...result.contractPaths };
    result.contractHashes = { ...result.contractHashes };

    const baseHref = path.dirname(this.document.uri.fsPath);
    for (const hash of Object.keys(data.contractPaths)) {
      const contractPaths = [...data.contractPaths[hash]];
      for (const contractPath of contractPaths) {
        if (path.isAbsolute(contractPath)) {
          const relativePath = path.relative(baseHref, contractPath);
          contractPaths.push(relativePath);
          result.contractHashes[relativePath] =
            result.contractHashes[contractPath];
        }
      }
      result.contractPaths[hash] = dedupeAndSort(contractPaths);
    }

    const connection = this.activeConnection.connection;
    if (connection?.rpcClient) {
      for (const contractHash of this.viewState.fileContents
        .filter((_) => _.contract?.startsWith("0x"))
        .map((_) => _.contract || "")) {
        try {
          const manifest = (
            await connection.rpcClient.getContractState(contractHash)
          ).toJson();
          result.contractManifests[manifest.abi.hash] = manifest;
        } catch {}
      }
    }

    return result;
  }

  private async onFileUpdate() {
    if (this.isClosed) {
      return;
    }
    try {
      let fileText = this.document.getText();
      if (fileText?.trim().length === 0) {
        fileText = "[]";
      }
      try {
        let fileContents = JSONC.parse(fileText) || [];
        if (!Array.isArray(fileContents)) {
          fileContents = [fileContents];
        }
        this.updateViewState({
          fileContents,
          errorText: "",
        });
      } catch {
        this.updateViewState({
          errorText: `There was a problem parsing "${path.basename(
            this.document.uri.fsPath
          )}". Try opening the file using the built-in editor and confirm that it contains valid JSON.`,
        });
        return;
      }
    } catch {
      this.updateViewState({
        errorText: `There was an error reading ${this.document.uri.fsPath}`,
      });
      return;
    }
  }

  private async periodicViewStateUpdate() {
    const connection = this.activeConnection.connection;

    const recentTransactions = await Promise.all(
      this.viewState.recentTransactions.map(async (_) => {
        if (_.tx && (_.tx as any).confirmations) {
          return _;
        } else {
          try {
            const tx = await connection?.rpcClient.getRawTransaction(
              _.txid,
              true
            );
            const vmstate = (tx as any).vmstate;
            return {
              txid: _.txid,
              blockchain: _.blockchain,
              tx,
              state: (vmstate === "FAULT"
                ? "error"
                : vmstate
                ? "ok"
                : "pending") as TransactionStatus,
            };
          } catch (e) {
            return _;
          }
        }
      })
    );

    const autoCompleteData = await this.augmentAutoCompleteData(
      this.autoComplete.data
    );

    this.updateViewState({
      autoCompleteData,
      recentTransactions,
    });
  }

  private async refreshLoop() {
    if (this.isClosed) {
      return;
    }
    try {
      await this.periodicViewStateUpdate();
    } finally {
      setTimeout(() => this.refreshLoop(), REFRESH_INTERVAL_MS);
    }
  }

  private async runFile(path: string) {
    let connection = this.activeConnection.connection;
    if (!connection) {
      await this.activeConnection.connect();
      await this.periodicViewStateUpdate();
      connection = this.activeConnection.connection;
    }
    if (
      connection &&
      connection.blockchainIdentifier.blockchainType === "express"
    ) {
      const walletNames = Object.keys(
        connection.blockchainIdentifier.getWalletAddresses()
      );
      const account = await IoHelpers.multipleChoice(
        "Select an account...",
        "genesis",
        ...walletNames
      );
      if (!account) {
        return;
      }
      await this.document.save();
      await this.updateViewState({ collapseTransactions: false });
      const result = this.neoExpress.runSync(
        "contract",
        "invoke",
        "-i",
        connection.blockchainIdentifier.configPath,
        path,
        account
      );
      if (result.isError) {
        await vscode.window.showErrorMessage(result.message);
      } else {
        const recentTransactions = [...this.viewState.recentTransactions];
        for (const txidMatch of ` ${result.message} `.matchAll(
          /\s0x[0-9a-f]+\s/gi
        )) {
          const txid = txidMatch[0].trim();
          recentTransactions.unshift({
            txid,
            blockchain: connection.blockchainIdentifier.name,
            state: "pending",
          });
        }
        if (recentTransactions.length > MAX_RECENT_TXS) {
          recentTransactions.length = MAX_RECENT_TXS;
        }
        this.updateViewState({ recentTransactions });
      }
    } else {
      await vscode.window.showWarningMessage(
        "Currently, you must be connected to a Neo Express blockchain to invoke contracts. Support for TestNet and MainNet contract invocation is coming soon."
      );
    }
  }

  private async runFragment(fragment: any) {
    const invokeFilePath = this.document.uri.fsPath;
    const tempFile = path.join(
      path.dirname(invokeFilePath),
      `.temp.${path.basename(invokeFilePath)}`
    );
    try {
      fs.writeFileSync(tempFile, JSON.stringify([fragment]));
      await this.runFile(tempFile);
    } catch (e) {
      console.warn(
        LOG_PREFIX,
        "Error running fragment",
        tempFile,
        fragment,
        e.message
      );
    } finally {
      try {
        fs.unlinkSync(tempFile);
      } catch (e) {
        console.warn(
          LOG_PREFIX,
          "Could not delete temporary file",
          tempFile,
          e.message
        );
      }
    }
  }
}
