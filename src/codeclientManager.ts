//why can't you just import like a normal????
import * as NBTTypes from "nbtify"
const NBT: typeof NBTTypes = require("fix-esm").require("nbtify");
import { RawData, WebSocket } from "ws"

type ElementOfSet<T> = T extends Set<infer E> ? E : never

const callbacks = {
    heartbeat:  new Set<(inventory: NBTTypes.ListTagLike) => Promise<void>>(),
    connectionStatusChanged: new Set<() => Promise<void>>(),
    codeModeLeft: new Set<() => Promise<void>>(),
    messageRecieved: new Set<(message: string) => Promise<void>>(),
}

const invClearQueue = new Set<number>()
const invRemoveImportQueue = new Set<number>()

export type CallbackTarget = keyof typeof callbacks

export const NEEDED_SCOPES = "write_code movement inventory"

export enum TaskType {
    Idle,
    Compiling
}


export let webSocket: WebSocket
export let currentTask: TaskType = TaskType.Idle
export let isConnected: boolean = false
export let isAuthed: boolean = false

let autoConnect = true
export async function setAutoConnect(val: boolean | undefined) {
    if (val === undefined) {val = false}
    autoConnect = val
}

export async function setCurrentTask(type: TaskType) {
    currentTask = type
}

export function attachCallback<T extends CallbackTarget, C extends ElementOfSet<typeof callbacks[T]>>(
    target: T, 
    callback: C
): C {
    //@ts-expect-error
    callbacks[target].add(callback)
    return callback
}

export function removeCallback<T extends CallbackTarget>(
    target: T, 
    callback: ElementOfSet<typeof callbacks[T]>
) {
    //@ts-expect-error
    callbacks[target].delete(callback)
}

export async function sendMessage(...message: string[]) {
    if (webSocket == null || webSocket.readyState != WebSocket.OPEN) {
        return
    }
    console.log("[codeclient out]:",message)
    webSocket.send(message.join(""))
}

export async function queueInvIndiciesForClear(slotIndicies: number[]) {
    for (const i of slotIndicies) {
        invClearQueue.add(i)
    }
}

export async function queueInvIndiciesForImportRemoval(slotIndicies: number[]) {
    for (const i of slotIndicies) {
        invRemoveImportQueue.add(i)
    }
}

export async function tryConnection() {
    if (webSocket) {
        webSocket.close()
    }

    //client
    webSocket = new WebSocket("ws://localhost:31375")
    
    webSocket.on("open",async () => {
        isConnected = true
        fireCallbacks("connectionStatusChanged")
        //request write code permission if this doesnt already have it
        let currentScopes = await getScopes()

        if (currentScopes != null) {
            if (!currentScopes.includes("write_code") || !currentScopes.includes("movement") || !currentScopes.includes("inventory")) {
                sendMessage(`scopes ${NEEDED_SCOPES}`)
            }
        }

    })

    webSocket.on("message",(message: RawData | string) => {
        message = message.toString()

        if (message == "auth") {
            isAuthed = true
            fireCallbacks("connectionStatusChanged")
            return
        }
        // console.log("[codeclient inc]:",message)

        fireCallbacks("messageRecieved",[message])
    })

    webSocket.on("close",() => {
        isConnected = false
        isAuthed = false
        fireCallbacks("connectionStatusChanged")
        console.log("CLOSED!")
    })
}


export const getScopes = makeCodeClientGetter<string[] | null>("scopes",null,(message, returnValue) => {
    let str = message.toString()
    if (str.match("default")) {
        returnValue(str.split(" "))
    }
})

export const getMode = makeCodeClientGetter<string>("mode","unknown",(message, returnValue) => {
    let str = message.toString()
    if (str == "spawn" || str == "play" || str == "build" || str == "code") {
        returnValue(str)
    }
})

export const getInventory = makeCodeClientGetter<NBTTypes.ListTagLike>("inv",[],(message, returnValue) => {
    let str = message.toString()
    try {
        const data = NBT.parse<NBTTypes.ListTagLike>(str)
        returnValue(data)
    } catch {}
})

async function fireCallbacks<T extends CallbackTarget>(target: T, args?: [...Parameters<ElementOfSet<typeof callbacks[T]>>]) {
    let promises: Promise<any>[] = []
    if (args === undefined) {
        //@ts-expect-error //@ts-pmo-🥀
        args = []
    }
    for (const cb of callbacks[target]) {
        //@ts-expect-error //@ts-pmo-🥀
        let p = cb(...args)
        promises.push(p)
    }

    await Promise.all(promises)
}

/**
 * used to create functions for getting specific values from ccapi
 * 
 * callback will run once for each incoming codeclient message that occurs after
 * the initial command is sent. it will continue to run until returnValue is called
 * or until it times out after 2 seconds pass.
 * 
 * before returning anything, the callback should perform some kind of validation
 * to prove that the message it recieved is actually connected to the proper request.
 */
function makeCodeClientGetter<R>(command: string, defaultValue: R, callback: (message: Buffer, returnValue: (value: R) => void) => void): (...args: string[]) => (Promise<R>) {
    return async (...args: string[]): (Promise<R>) => {
        return await new Promise<R>(resolve => {
            let resolved = false
    
            sendMessage(command,...args)
    
            setTimeout(() => {
                if (!resolved) {
                    webSocket.removeListener("message",internalCallback)
                    resolve(defaultValue)
                }
            },2000)

            function returnValue(value: R) {
                webSocket.removeListener("message",internalCallback)
                resolve(value)
            }
    
            function internalCallback(message: Buffer) {
                callback(message,returnValue)
            }
    
            webSocket.addListener("message",internalCallback)
        })
    }
}

let lastMode: string | undefined
export async function heartbeat() {
    if (currentTask != TaskType.Idle) { return }
    if (!isAuthed) { return }

    //only do inv syncing while in dev
    let mode = await getMode()
    if (mode != "code") {

        //if auth is removed by the player
        //this shouldn't be in the inv syncing function but i do not care
        if (mode == "unknown") {
            isAuthed = false
            fireCallbacks("connectionStatusChanged")
        }

        //if just switching out of dev, stop editing all items
        if (lastMode == "code") {
            fireCallbacks("codeModeLeft")
        }

        lastMode = mode
        return
    } else {
        lastMode = mode
    }

    let inventory = await getInventory()

    await fireCallbacks("heartbeat",[inventory])

    let changes = invRemoveImportQueue.size + invClearQueue.size
    if (invRemoveImportQueue.size > 0) {
        invRemoveImportQueue.forEach(i => {
            let item = inventory[i]
            let tags = item.components?.["minecraft:custom_data"]?.PublicBukkitValues
            if (tags) {
                delete tags["hypercube:__tc_ii_import"]
            }
        })
        invRemoveImportQueue.clear()
    }
    if (invClearQueue.size > 0) {
        invClearQueue.forEach(i => inventory[i] = undefined) //set all slots marked for removal as undefined
        inventory.filter(e => e) //actually remove undefined slots from the array
        invClearQueue.clear()
    }
    if (changes > 0) {
        sendMessage("setinv " + NBT.stringify(inventory))
    }
}

setInterval(heartbeat, 1000)

setInterval(() => {
    if (autoConnect && !isConnected) {
        tryConnection()
    }
},10000)
tryConnection()