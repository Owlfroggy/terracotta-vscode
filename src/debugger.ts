import { DebugProtocol as dap } from "vscode-debugprotocol"

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

let scopesResolve: ((scopes: string[]) => void) | undefined = undefined

const requestHandlers: {[key: string]: (args: dap.Request) => void} = {
    "initialize": function(request) {
        sendResponse(request,{
            supportsConfigurationDoneRequest: true
        })
    },
    "launch": async function(request) {
        sendResponse(request,{})
        
        if (request.arguments.exportMode == "sendToCodeClient") {
            let scopes = await new Promise<string[]>(resolve => {
                sendEvent("requestScopes")
                //throwing the resolve function out there for the returnScopes handler to deal with
                //is such a war crime but im too lazy to figure out a less stupid way to do it
                scopesResolve = resolve
            })

            //error if user has not authorized codeclient to write code
            if (!scopes.includes("write_code")) {
                sendEvent("showErrorMessage","Terracotta is missing permsissions, please run /auth in Minecraft")
                process.exit(126)
            }

            //placeholder code
            sendEvent("codeclient",'place swap') 
            sendEvent("codeclient",'place H4sIAAAAAAACA+VWXWvCMBT9KyUwmMOHbX5s9GljDtmDLyqyD6TE9lrL0qQ0qZuI/303rUrUulWHg7KnNsm5556eHMqdkxET7rsk9tucBB6xszWpLp82GSfcxSWNfQQhRkGo0cNFlXhUUUTQD5AiBLKo7qGQoJwpjXNYsrd0RxdmoIx2TjhFUpvcOU7/wek+tp0rPJSuiPQuCzh2RBGSCUXsy7T5j1wjypg0WBIu6RQ8g+hqh4gn4S7RpVFyXaykZpTUFto/6qpAcDwagKtEfHoDrw8x0MeWzGBTs7SuFcSoVuuuEoVyAItJC8Y0YepbH0fMUdQ3CXFlkwcRRoIDV3gioqUhz/kfv/KrDSqzTBebN9Hc9HULd2p7a7/OZ6Gs/0dr62VJ7ksp7W2UIbnltLZZluS+ltLemzIkt5zW3h5ibe7IcxZSNTk/wz7nxhBSudjaqVUqh09gudz1He7GBnfBUS2Xu7nDfbPBfeBMFzE6g9hZ4v/0rvZE954FPg8xulZHeGDmtwt+wlIBe9WvPrsH3OuAlNQ3NWCSC4row6eyBpQlYHUg9gOuIWsh955nyYi6oIf4Y7U0imp54hOIA2X11IylHdc6+nGiDTpWQX0zKiYq7wc/XHwBFjf2p6cNAAA=') 
            sendEvent("codeclient",'place go') 
        }
    },
    "codeclientMessage": function(request) {
        if (request.arguments == "place done") {
            process.exit(0)
        }
    },
    "returnScopes": function(request) {
        if (scopesResolve) {
            scopesResolve(request.arguments)
            scopesResolve = undefined
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