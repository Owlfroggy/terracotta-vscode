import { DebugProtocol as dap } from "vscode-debugprotocol"
import * as cp from "node:child_process"
import * as vscode from "vscode"

let splitPath = __dirname.split("/")
splitPath.pop()
let bunPath = (splitPath.join("/")+"/node_modules/.bin/bun").replace(/ /g,"\\ ").replace(/"/g,'\\"')

export interface DebuggerExtraInfo {
    scopes: string[],
    mode: "spawn" | "play" | "build" | "code" | "unknown"
    terracottaInstallPath: string
}

//==========[ util functions ]=========\

function sendEvent(event: string, body: any = null) {
    let str = JSON.stringify({
        type: "event",
        event: event,
        body: body
    })
    
    process.stdout.write(`Content-Length: ${Buffer.from(str,"utf-8").length}\r\n\r\n${str}`)
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

let info: DebuggerExtraInfo
let launchArguments: any

let infoResolve: ((scopes: DebuggerExtraInfo) => void) | undefined = undefined
let isInDevResolve: ((value: unknown) => void) | undefined = undefined

const requestHandlers: {[key: string]: (args: dap.Request) => void} = {
    "initialize": function(request) {
        sendResponse(request,{
            supportsConfigurationDoneRequest: true
        })
    },
    "launch": async function(request) {
        sendResponse(request,{})
        
        if (request.arguments.exportMode == "sendToCodeClient") {
            launchArguments = request.arguments
            info = await new Promise<DebuggerExtraInfo>(resolve => {
                sendEvent("requestInfo")
                //throwing the resolve function out there for the returnScopes handler to deal with
                //is such a war crime but im too lazy to figure out a less stupid way to do it
                infoResolve = resolve
            })

            let templates: string[] = []
            try {
                let command = `cd "${info.terracottaInstallPath}"; ${bunPath} run "${info.terracottaInstallPath}src/main.ts" --compile --project "${request.arguments.folder}" --plotsize ${launchArguments.plotSize}`
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
                    output: "Terracotta does is missing codeclient permissions. Please run /auth in your Minecraft client",
                    category: "console",
    
                })
                sendEvent("redoScopes")
                process.exit(126)
            }
            else if (info.mode == "unknown") {
                sendEvent('output',{
                    output: "Could not get mode data from codeclient. Wait a few seconds for the codeclient connection to refresh then try again. (If this message keeps appearing, try restarting minecraft)",
                    category: "console",
                })
                sendEvent("refreshCodeClient")
                process.exit(1)
            }
            else if (info.mode == "spawn") {
                sendEvent('output',{
                    output: "Terracotta cannot compile to a plot if you are not on a plot.",
                    category: "console",
                    
                })
                process.exit(126)
            }
            else if (info.mode != "code") {
                if (request.arguments.autoSwitchToDev) {
                    sendEvent('output',{
                        output: `Switching to dev mode (currently in ${info.mode} mode)\n`,
                        category: "console",
                    })
                    await new Promise(resolve => {
                        sendEvent("switchToDev")
                        isInDevResolve = resolve
                    })
                } else {
                    sendEvent('output',{
                        output: `You are currently in ${info.mode} mode. Please switch to dev or add '"autoSwitchToDev": true' to your launch configuration.`,
                        category: "console",
        
                    })
                    process.exit(126)
                }
            }
            
            sendEvent('output',{
                output: `Starting to place code\n`,
                category: "console",
            })

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
            sendEvent('output',{
                output: `Code placing complete! ${launchArguments.autoSwitchToPlay ? "Automatically switching to play mode" : ""}\n`,
                category: "console",
            })
            if (launchArguments.autoSwitchToPlay) {
                sendEvent("codeclient","mode play")
            }
            process.exit(0)
        }
        else if (request.arguments == "aborted") {
            sendEvent('output',{
                output: `Code placing was aborted from within minecraft\n`,
                category: "console",
            })
            process.exit(1)
        }
    },
    "returnInfo": function(request) {
        if (infoResolve) {
            infoResolve(request.arguments)
            infoResolve = undefined
        }
    },
    "responseNowInDev": function(request) {
        if (isInDevResolve) {
            isInDevResolve(null)
            isInDevResolve = undefined
        }
    }
}

process.stdin.on("data",data => {
    let commands = data.toString().split(/Content-Length: \d+\r\n\r\n/g)
    commands.shift() //since the first entry will always be an empty string

    for (let command of commands) {
        let json = JSON.parse(command)
        if (json.type == "request") {
            if (requestHandlers[json.command]) {
                requestHandlers[json.command](json)
            }   
        }
    }
})