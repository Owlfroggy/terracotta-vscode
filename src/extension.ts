import * as cp from "child_process";
import * as path from "path"
import * as vscode from 'vscode';
import { RawData, WebSocket } from 'ws';
import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';
import { DebuggerExtraInfo } from "./debugger";


const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("terracotta")
const debuggers: {[key: string]: vscode.DebugSession} = {}

let client: LanguageClient

//==========[ file paths ]=========\

let splitPath = __dirname.split("/")
splitPath.pop()
let bunPath = (splitPath.join("/")+"/node_modules/.bin/bun").replace(/ /g,"\\ ").replace(/"/g,'\\"')

let terracottaPath = (config.get("installPath") as string).replace(/"/g,'\\"')
if (!terracottaPath.endsWith("/")) { terracottaPath += "/" }

let mainScriptPath = terracottaPath + "src/main.ts"

//==========[ codeclient ]=========\

let neededScopes = "write_code movement"
let codeClientWS: WebSocket


function codeclientMessage(message: string) {
	console.log("[codeclient out]:",message)
	codeClientWS.send(message)
}

async function getCodeClientScopes(): Promise<string[]> {
	return await new Promise<string[]>(resolve => {
		codeclientMessage("scopes")

		function callback(message: Buffer) {
			let str = message.toString()
			if (str.match("default")) {
				codeClientWS.removeListener("message",callback)
				resolve(str.split(" "))
			}
		}

		codeClientWS.addListener("message",callback)
	})
}

async function getCodeClientMode(): Promise<string> {
	return await new Promise<string>(resolve => {
		let resolved = false

		codeclientMessage("mode")

		setTimeout(() => {
			if (!resolved) {
				codeClientWS.removeListener("message",callback)
				resolve("unknown")
			}
		},2000)

		function callback(message: Buffer) {
			let str = message.toString()
			if (str == "spawn" || str == "play" || str == "build" || str == "code") {
				codeClientWS.removeListener("message",callback)
				resolve(str)
			}
		}

		codeClientWS.addListener("message",callback)
	})
}

async function setupCodeClient() {
	if (codeClientWS) {
		codeClientWS.close()
	}

	//client
	codeClientWS = new WebSocket("ws://localhost:31375")
    
	codeClientWS.on("open",async () => {
		//request write code permission if this doesnt already have it
		let currentScopes = await getCodeClientScopes()

		if (!currentScopes.includes("write_code")) {
			codeclientMessage(`scopes ${neededScopes}`)
		}
	})

	codeClientWS.on("message",(message: RawData | string) => {
		message = message.toString()

		console.log("[codeclient inc]:",message)

		for (const session of Object.values(debuggers)) {
			session.customRequest("codeclientMessage",message)
		}
	})
}

//==========[ extension events ]=========\

export function activate(context: vscode.ExtensionContext) {
	let outputChannel = vscode.window.createOutputChannel("Terracotta LSP")
		
	setupCodeClient()

	//= commands =\\
	vscode.commands.registerCommand("extension.terracotta.refreshCodeClient",() => {
		setupCodeClient();
	})

	//= set up debugger =\\

	//split up all the async callbacks into their own group to avoid
	//async'ing all the syncronous ones
	vscode.debug.onDidReceiveDebugSessionCustomEvent(async event => {
		//i would use an ACTUAL REQUEST for this but theres not a callback for that 
		if (event.event == "requestInfo") {
			event.session.customRequest("returnInfo",{
				scopes: await getCodeClientScopes(),
				mode: await getCodeClientMode(),
				terracottaInstallPath: terracottaPath
			} as DebuggerExtraInfo)
		}
		else if (event.event == "switchToDev") {
			codeclientMessage("mode code")

			let intervalId: any

			function callback(message: string) {
				if (message == "code") {
					codeClientWS.removeListener("message",callback)
					clearInterval(intervalId)
					event.session.customRequest("responseNowInDev")
				}
			}

			intervalId = setInterval(() => {
				codeClientWS.send("mode")
			},500)

			codeClientWS.on("message",callback)
		}
	})

	vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
		if (event.event == "log") {
			console.log(event.body)
		}
		else if (event.event == "showErrorMessage") {
			vscode.window.showErrorMessage(event.body)
		}
		else if (event.event == "codeclient") {
			codeclientMessage(event.body)
		}
		else if (event.event == "redoScopes") {
			codeclientMessage(`scopes ${neededScopes}`)
		}
		else if (event.event == "refreshCodeClient") {
			setupCodeClient()
		}
	})

	vscode.debug.onDidStartDebugSession(session => {
		debuggers[session.id] = session
	})

	vscode.debug.onDidTerminateDebugSession(session => {
		delete debuggers[session.id]
	})

	//= set up language server =\\
	let server: cp.ChildProcess

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
			fileEvents: vscode.workspace.createFileSystemWatcher('**/.clientrc')
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