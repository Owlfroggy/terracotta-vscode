import * as cp from "child_process";
import * as path from "path"
import * as vscode from 'vscode';
import {workspace} from "vscode"


import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
} from 'vscode-languageclient/node';


const config: vscode.WorkspaceConfiguration = workspace.getConfiguration("terracotta")
let client: LanguageClient

//file paths
let splitPath = __dirname.split("/")
splitPath.pop()
let bunPath = (splitPath.join("/")+"/node_modules/.bin/bun").replace(/ /g,"\\ ").replace(/"/g,'\\"')

let terracottaPath = (config.get("installPath") as string).replace(/"/g,'\\"')
if (!terracottaPath.endsWith("/")) { terracottaPath += "/" }

let mainScriptPath = terracottaPath + "src/main.ts"


export function activate(context: vscode.ExtensionContext) {
	let server: cp.ChildProcess
	let outputChannel = vscode.window.createOutputChannel("Terracotta LSP")

	//lmao i am so sorry
	let serverOptions: ServerOptions = async function() {
		if (process.platform == "darwin") {
			/*
				this one line is the single hackiest line of code i have ever written
				- the server has to be piped through cat because when the server is started directly, stdin immediately closes for no reason
				- because it has to be piped, its using exec and not spawn (yes i tried just using exec without piping but to no avail)
				- maxBuffer is set to infinity because apparently maxBuffer just sets a limit on how much data can be passed through the child's stdout before it violently crahes

				honestly i probably should have just spent a year learning rust
			*/
			server = cp.exec(`cd "${terracottaPath}"; cat | ${bunPath} run "${mainScriptPath}" --server`,{maxBuffer: Infinity})
		}
		else if (process.platform == "win32") {
			
		}
				
		return Promise.resolve(server)
	}
	
	// Options to control the language client
	let clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'terracotta' }],
		synchronize: {
			fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
		},
		outputChannel: outputChannel,
		outputChannelName: "terracotta"
	};

	outputChannel.show()

	// Create the language client and start the client.
	client = new LanguageClient(
		'terracotta',
		'Terracotta',
		serverOptions,
		clientOptions
	);

	// Start the client. This will also launch the server
	client.start()
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined
	}
	console.log("DEACTIVATE")
	return client.stop()
}