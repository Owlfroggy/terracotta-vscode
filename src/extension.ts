import * as cp from "child_process";
import * as path from "path"
import * as vscode from 'vscode';
import {workspace} from "vscode"
import { RawData, WebSocket } from 'ws';
import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';


const config: vscode.WorkspaceConfiguration = workspace.getConfiguration("terracotta")
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

let codeClientWS: WebSocket

async function getCodeClientScopes(): Promise<string[]> {
	return await new Promise<string[]>(resolve => {
		codeClientWS.send("scopes")

		//i have no idea what happens if a message other than the scopes return gets recieved
		//i assume the code will just see "oh no i dont have the scopes" and request new ones
		codeClientWS.once("message",message => {
			let scopes = message.toString().split(" ")
			resolve(scopes)
		})
	})
}

async function setupCodeClient() {
	//client
	codeClientWS = new WebSocket("ws://localhost:31375")
    
	codeClientWS.on("open",async () => {
		//request write code permission if this doesnt already have it
		let currentScopes = await getCodeClientScopes()

		if (!currentScopes.includes("write_code")) {
			codeClientWS.send("scopes write_code")
		}
	})

	codeClientWS.on("message",(message: RawData | string) => {
		message = message.toString()

		for (const session of Object.values(debuggers)) {
			session.customRequest("codeclientMessage",message)
		}
	})
}

//==========[ extension events ]=========\

export function activate(context: vscode.ExtensionContext) {
	let outputChannel = vscode.window.createOutputChannel("Terracotta LSP")
		
	setupCodeClient()

	//= set up debugger =\\

	//split up all the async callbacks into their own group to avoid
	//async'ing all the syncronous ones
	vscode.debug.onDidReceiveDebugSessionCustomEvent(async event => {
		//i would use an ACTUAL REQUEST for this but theres not a callback for that 
		if (event.event == "requestScopes") {
			event.session.customRequest("returnScopes",await getCodeClientScopes())
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
			codeClientWS.send(event.body)
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