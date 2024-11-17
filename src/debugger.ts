import { DebugProtocol as dap } from "vscode-debugprotocol"
import * as cp from "node:child_process"
import * as fs from "fs/promises"
import * as vscode from "vscode"
import { pathToFileURL } from "node:url"
import * as crypto from "node:crypto"
import { Stats } from "node:fs"
import {URL} from "url"
import { Dict } from "./util/dict"

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

let tcMetaFolderPath: URL
let hashFilePath: URL
let newHashFilePath: URL

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

            if (info.scopes == null) {
                sendEvent('output',{
                    output: "CodeClient is not connected. If Minecraft is actually running, try 'Refresh CodeClient Connection' from the Command Pallette.",
                    category: "console",
                })
                process.exit(1)
            }

            let folderUrl = pathToFileURL(request.arguments.folder)
            
            tcMetaFolderPath = pathToFileURL(request.arguments.folder); tcMetaFolderPath.pathname += "/.terracotta/"
            hashFilePath = pathToFileURL(request.arguments.folder); hashFilePath.pathname += "/.terracotta/templateHash"
            newHashFilePath = pathToFileURL(request.arguments.folder); newHashFilePath.pathname += "/.terracotta/newTemplateHash"

            //create .terracotta folder if it doesnt already exist
            try {
                await fs.stat(tcMetaFolderPath)
            } catch (e: any) {
                if (e.errno == -2) {
                    await fs.mkdir(tcMetaFolderPath)
                } else {
                    sendEvent('output',{
                        output: `Could not access .terracotta folder (error code:${e.errno})`,
                        category: "stderr",
                    })
                }
            }

            let templates: Dict<any>
            try {
                let command = `cd "${info.terracottaInstallPath}"; ~/.deno/bin/deno run --allow-read --allow-env "${info.terracottaInstallPath}src/main.ts" compile --project "${request.arguments.folder}" --includemeta --plotsize ${launchArguments.plotSize}`
                sendEvent('output',{
                    output: command,
                    category: "stderr",
                })
                templates = JSON.parse(cp.execSync(command).toString())
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
                    output: "Terracotta is missing codeclient permissions. Please run /auth in your Minecraft client",
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

            //= figure out what templates should be changed =\\
            let seenTemplates: Dict<Set<string>> = {
                functions: new Set<string>(),
                processes: new Set<string>(),
                playerEvents: new Set<string>(),
                entityEvents: new Set<string>(),
            }

            let oldTemplatesHashes: Dict<Dict<string>> = {
                functions: {},
                processes: {},
                playerEvents: {},
                entityEvents: {},
            }
            
            //read hashes of the last compilation
            let fileContents: string | undefined = undefined
            try {
                fileContents = (await fs.readFile(hashFilePath)).toString()
            } catch (e) {}
            if (fileContents) {
                let headerType: string | undefined = undefined
                fileContents.split("\n").forEach(line => {
                    //lines denoting change in header type
                    if (line.startsWith(">")) {
                        headerType = line.substring(1)
                        if (!(headerType in oldTemplatesHashes)) {headerType = undefined}
                    }
                    //lines for templates
                    else if (headerType) {
                        let [hash, name] = line.split(/ (.*)/)
                        seenTemplates[headerType]!.add(name)
                        oldTemplatesHashes[headerType]![name] = hash
                    }
                })
            }


            let newHashFileContents: string = ""
            let placerCommands: string[] = []

            ;["functions","processes","playerEvents","entityEvents"].forEach(headerType => {
                let hashes: Dict<string> = {}

                //get hashes of new templates
                newHashFileContents += ">"+headerType+"\n"
                for (const [name, template] of Object.entries(templates[headerType]) as [string,string][]) {
                    let hash = crypto.createHash('md5').update(template).digest("hex")

                    seenTemplates[headerType]!.add(name)
                    hashes[name] = hash
                    
                    newHashFileContents += hash+" "+name+"\n"
                }

                //create codeclient commands
                seenTemplates[headerType]!.forEach(templateName => {
                    if (!(templateName in hashes)) {
                        //remove command (when codeclient adds it)
                    }
                    //if template is new or has changed
                    else if (!(templateName in oldTemplatesHashes[headerType]!) || hashes[templateName] != oldTemplatesHashes[headerType]![templateName]) {
                        placerCommands.push(`place ${templates[headerType][templateName]}`)
                    }
                })
            })


            await fs.writeFile(newHashFilePath,newHashFileContents,"utf-8")
            

            //= actually send to the placer =\\

            if (placerCommands.length == 0) {
                sendEvent('output',{
                    output: `No template changes detected since last compilation\n`,
                    category: "console",
                })
                if (launchArguments.autoSwitchToPlay) {
                    sendEvent("codeclient","mode play")
                }
                
                await fs.rename(newHashFilePath,hashFilePath)

                process.exit(0)
            }
            else {
                sendEvent('output',{
                    output: `Starting to place code\n`,
                    category: "console",
                })

                sendEvent("codeclient",'place swap') 
                placerCommands.forEach(command => sendEvent("codeclient",command))
                sendEvent("codeclient",'place go')
            }
        }
    },
    "codeclientMessage": async function(request) {
        if (request.arguments == "place done") {
            sendEvent('output',{
                output: `Code placing complete! ${launchArguments.autoSwitchToPlay ? "Automatically switching to play mode" : ""}\n`,
                category: "console",
            })
            if (launchArguments.autoSwitchToPlay) {
                sendEvent("codeclient","mode play")
            }

            await fs.rename(newHashFilePath,hashFilePath)

            process.exit(0)
        }
        else if (request.arguments == "aborted") {
            sendEvent('output',{
                output: `Code placing was aborted from within minecraft\n`,
                category: "console",
            })

            await fs.rm(newHashFilePath)

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