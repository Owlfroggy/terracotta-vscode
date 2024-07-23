import { DebugProtocol as dap } from "vscode-debugprotocol"
import * as cp from "node:child_process"
import * as vscode from "vscode"

let splitPath = __dirname.split("/")
splitPath.pop()
let bunPath = (splitPath.join("/")+"/node_modules/.bin/bun").replace(/ /g,"\\ ").replace(/"/g,'\\"')

export interface DebuggerExtraInfo {
    scopes: string[],
    terracottaInstallPath: string
}

//==========[ util functions ]=========\

function sendEvent(event: string, body: any = null) {
    let str = JSON.stringify({
        type: "event",
        event: event,
        body: body
    })
    
    process.stdout.write(`Content-Length: ${str.length}\r\n\r\n${str}`)
}

function sendResponse(request: dap.Request, body: any, successful: boolean = true) {
    let str = JSON.stringify({
        type: "response",
        request_seq: request.seq,
        command: request.command,
        success: successful,
        body: body
    })
    
    process.stdout.write(`Content-Length: ${str.length}\r\n\r\n${str}`)
}

//==========[ actual debugger stuff ]=========\

let infoResolve: ((scopes: DebuggerExtraInfo) => void) | undefined = undefined

const requestHandlers: {[key: string]: (args: dap.Request) => void} = {
    "initialize": function(request) {
        sendResponse(request,{
            supportsConfigurationDoneRequest: true
        })
    },
    "launch": async function(request) {
        sendResponse(request,{})
        
        if (request.arguments.exportMode == "sendToCodeClient") {
            let info = await new Promise<DebuggerExtraInfo>(resolve => {
                sendEvent("requestInfo")
                //throwing the resolve function out there for the returnScopes handler to deal with
                //is such a war crime but im too lazy to figure out a less stupid way to do it
                infoResolve = resolve
            })

            let templates: string[] = []
            try {
                let command = `cd "${info.terracottaInstallPath}"; ${bunPath} run "${info.terracottaInstallPath}src/main.ts" --compile --project "${request.arguments.folder}"`
                templates = cp.execSync(command,{maxBuffer: Infinity,}).toString().split("\n")
            }
            catch (e: any) {
                sendEvent('output',{
                    output: e.output[2].toString(),
                    category: "stderr",

                })
                process.exit(1)
            }

            //make sure codeclient can actually do the thing
            if (!info.scopes.includes("write_code")) {
                sendEvent('output',{
                    output: "Terracotta does not have permission to edit code. Please run /auth in your Minecraft client",
                    category: "console",

                })
                process.exit(126)
            }
            
            //send code to codeclient placer
            sendEvent("codeclient",'place swap') 
            templates.forEach(template => {
                sendEvent("codeclient",`place ${template}`)
            })
            sendEvent("codeclient",'place go') 
        }
    },
    "codeclientMessage": function(request) {
        if (request.arguments == "place done") {
            process.exit(0)
        }
    },
    "returnInfo": function(request) {
        if (infoResolve) {
            infoResolve(request.arguments)
            infoResolve = undefined
        }
    }
}

process.stdin.on("data",data => {
    let lines = data.toString().split("\r\n")
    let json = JSON.parse(lines[2])
    if (json.type == "request") {
        if (requestHandlers[json.command]) {
            requestHandlers[json.command](json)
        }   
    }
})