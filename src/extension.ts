import * as cp from "child_process";
import * as path from "path"
import * as vscode from 'vscode';
import { RawData, WebSocket } from 'ws';
import { LanguageClient, LanguageClientOptions, ServerOptions, StreamMessageReader } from 'vscode-languageclient/node';
import { DebuggerExtraInfo } from "./debugger";
import * as fs from "fs/promises"
import { fileURLToPath, pathToFileURL, URL } from "url";
import { Dict } from "./util/dict"
import * as npc from "copy-paste"
const stableStringify = require("json-stable-stringify")
//why can't you just import like a normal????
import * as NBTTypes from "nbtify"
const NBT: typeof NBTTypes = require("fix-esm").require("nbtify");
import { VersionManager } from "./versionManager";
import { compareVersions } from "./util/compareVersions";

//the current DF_NBT value df uses. keeping this updated is required
//to make sure item data doesnt break between minecraft versions
const DF_NBT = 3955
const EXTENSION_VERSION = "0.0.1"

const debuggers: {[key: string]: vscode.DebugSession} = {}
const validItemIds: Dict<boolean> = {}
const itemIcons: Dict<string> = {}

let client: LanguageClient
let outputChannel: vscode.OutputChannel
let urlStringToLibMap: Dict<ItemLibraryFile> = {}

let itemEditorProvider: ItemLibraryEditorProvider
let itemLibraries: Dict<Dict<ItemLibraryFile>> = {}
let areLibrariesLoaded: boolean = false
//layer 1 = projects (key: project path, value: dict of libraries)
//layer 2 = libraries (key: library id, value: dict of items)
//layer 3 = items (key: item id, value: true if being edited, undefined if not)
let itemsBeingEdited: Dict<Dict<Dict<boolean>>> = {}
let itemImportId: number | undefined //will be undefined if no item is being edited
let returnItemBeingImported: ((value: any) => void) | undefined

let codeClientTask: "idle" | "compiling" = "idle"
let codeClientConnected = false
let codeClientAuthed = false

let versionManager: VersionManager

//==========[ file paths ]=========\

const delimiter = process.platform == "win32" ? "\\" : "/"
let splitPath = __dirname.split("/")
splitPath.pop()
let bunPath = (splitPath.join("/")+"/node_modules/.bin/bun").replace(/ /g,"\\ ").replace(/"/g,'\\"')

let terracottaPath: string
let sourcePath: string
let mainScriptPath: string

let useSourceCode: boolean

function updateTerracottaPath() {
	// terracottaPath = (config.get("installPath") as string)
	terracottaPath = versionManager.getExecutablePath(getConfigValue("version")!)

	sourcePath = (getConfigValue("sourcePath") as string).replaceAll("\\","\\\\").replaceAll('"','\\"').replaceAll("'","\\'")
	if (!sourcePath.endsWith(delimiter)) { sourcePath += delimiter }
	mainScriptPath = sourcePath + `src${delimiter}main.ts`
	useSourceCode = getConfigValue("useSourceCode")!
}


//==========[ random util functions that really should be in a seperate file™ ]=========\

function ensurePathExistance(to: Dict<any>, ...path: string[]){
    let currentLevel: any = to

    for (const key of path) {
        if (!(key in currentLevel)) {
            currentLevel[key] = {}
        }
        currentLevel = currentLevel[key]
    }

    return currentLevel
}

function getConfigValue<T>(key: string): T | undefined {
	return vscode.workspace.getConfiguration("terracotta").get<T>(key)
}

//==========[ codeclient ]=========\

let neededScopes = "write_code movement inventory"
let codeClientWS: WebSocket


function codeclientMessage(...message: string[]) {
	if (codeClientWS == null || codeClientWS.readyState != WebSocket.OPEN) {
		return
	}
	console.log("[codeclient out]:",message)
	codeClientWS.send(message.join(""))
}

/*used to create functions for getting specific values from ccapi

callback will run once for each incoming codeclient message that occurs after
the initial command is sent. it will continue to run until returnValue is called
or until it times out after 2 seconds pass.

before returning anything, the callback should perform some kind of validation
to prove that the message it recieved is actually connected to the proper request.
*/

function makeCodeClientGetter<R>(command: string, defaultValue: R, callback: (message: Buffer, returnValue: (value: R) => void) => void): (...args: string[]) => (Promise<R>) {
	return async (...args: string[]): (Promise<R>) => {
		return await new Promise<R>(resolve => {
			let resolved = false
	
			codeclientMessage(command,...args)
	
			setTimeout(() => {
				if (!resolved) {
					codeClientWS.removeListener("message",internalCallback)
					resolve(defaultValue)
				}
			},2000)

			function returnValue(value: R) {
				codeClientWS.removeListener("message",internalCallback)
				resolve(value)
			}
	
			function internalCallback(message: Buffer) {
				callback(message,returnValue)
			}
	
			codeClientWS.addListener("message",internalCallback)
		})
	}
}

const getCodeClientScopes = makeCodeClientGetter<string[] | null>("scopes",null,(message, returnValue) => {
	let str = message.toString()
	if (str.match("default")) {
		returnValue(str.split(" "))
	}
})

const getCodeClientMode = makeCodeClientGetter<string>("mode","unknown",(message, returnValue) => {
	let str = message.toString()
	if (str == "spawn" || str == "play" || str == "build" || str == "code") {
		returnValue(str)
	}
})

const getCodeClientInventory = makeCodeClientGetter<NBTTypes.ListTagLike>("inv",[],(message, returnValue) => {
	let str = message.toString()
	try {
		// mojangson method
		// const data = mojangson.parse(str)
		const data = NBT.parse<NBTTypes.ListTagLike>(str)
		returnValue(data)
	} catch {}
})

async function setupCodeClient() {
	if (codeClientWS) {
		codeClientWS.close()
	}

	//client
	codeClientWS = new WebSocket("ws://localhost:31375")
    
	codeClientWS.on("open",async () => {
		codeClientConnected = true
		//request write code permission if this doesnt already have it
		let currentScopes = await getCodeClientScopes()

		if (currentScopes != null) {
			if (!currentScopes.includes("write_code") || !currentScopes.includes("movement") || !currentScopes.includes("inventory")) {
				codeclientMessage(`scopes ${neededScopes}`)
			}
		}

	})

	codeClientWS.on("message",(message: RawData | string) => {
		message = message.toString()

		if (message == "auth") {
			codeClientAuthed = true
			return
		}
		// console.log("[codeclient inc]:",message)

		for (const session of Object.values(debuggers)) {
			session.customRequest("codeclientMessage",message)
		}
	})

	codeClientWS.on("close",() => {
		codeClientConnected = false
		codeClientAuthed = false
		console.log("CLOSED!")
	})
}

//==========[ item library editor ]=========\

interface ItemLibraryFile {
	id: string,
	items: {[key: string]: {version: number, data: string}},
	compilationMode: "item" | "variable"
	fileURL: URL,
	projectURL: URL,
}

class ProjectTreeItem extends vscode.TreeItem {
	constructor(
		public readonly label: string,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly path: string,
	) {
		super(label, collapsibleState);
	}
}

class LibraryTreeItem extends vscode.TreeItem {
	constructor(
		public readonly label: string,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly library: ItemLibraryFile,
	) {
		super(label, collapsibleState);
	}
}
class ItemTreeItem extends vscode.TreeItem {
	constructor(
		public readonly label: string,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly library: ItemLibraryFile,
		public readonly itemId: string
	) {
		super(label, collapsibleState);
	}
}

export class ItemLibraryEditorProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	constructor(
		private readonly context: vscode.ExtensionContext
	) {}

	getChildren(element?: vscode.TreeItem | undefined): vscode.ProviderResult<vscode.TreeItem[]> {
		if (!areLibrariesLoaded) {
			if (element == undefined) {
				return [new vscode.TreeItem("Loading...",vscode.TreeItemCollapsibleState.None)]
			} else {
				return
			}
		}
		let items: vscode.TreeItem[] = []

		if (element) {
			if (element instanceof ProjectTreeItem) {
				let ids = Object.keys(itemLibraries[element.path]!)
				
				for (const id of ids) {
					let library = itemLibraries[element.path]![id]!
					let item = new LibraryTreeItem(id,ids.length == 1 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,library)
					item.contextValue = "library"
					item.description = decodeURIComponent(new URL(library.fileURL).toString().substring(library.projectURL.toString().length))
					items.push(item)
				}
			}
			else if (element instanceof LibraryTreeItem) {
				for (const [id, data] of Object.entries(element.library.items)) {
					let item = new ItemTreeItem(id,vscode.TreeItemCollapsibleState.None,element.library,id)
					item.contextValue = "item"

					// display differently if item is being edited
					if (itemsBeingEdited[element.library.projectURL.toString()]?.[element.library.id]?.[id]) {
						item.contextValue = "itemBeingEdited"
						item.description = "(editing)"
					}

					//parse item data
					let parsedData: NBTTypes.RootTagLike | undefined
					try {
						parsedData = NBT.parse(data.data)
					} catch {}

					//display as an error if the item data is malformed
					if (!parsedData || !("version" in data) || !("id" in parsedData) || !(typeof parsedData.id === 'string' || parsedData.id instanceof String)) {
						item.contextValue = "invalidItem",
						item.description  = "ERROR ❌"
						item.iconPath = vscode.Uri.joinPath(this.context.extensionUri,"/assets/icons/invalid_item.svg")
					} 
					else {
						//handle different data versions
						if (data.version != DF_NBT) {
							item.contextValue = "outdatedItem"
							item.description = "(needs migration)"
						}
						//if item is completely valid, set icon info based on parsed item id
						let itemId = parsedData.id as string
						if (itemId.startsWith("minecraft:")) {
							itemId = itemId.substring("minecraft:".length)
						}
						if (itemId in itemIcons) {
							item.iconPath = vscode.Uri.parse(itemIcons[itemId]!)
						}
					}
					
					items.push(item)

				}
			}
		} else {
			let projectPaths = Object.keys(itemLibraries)
			for (const path of projectPaths) {
				let item = new ProjectTreeItem(decodeURIComponent(new URL(path).pathname.split("/").at(-1)!),vscode.TreeItemCollapsibleState.Expanded,path)
				item.contextValue = "project"
				if (path.length == 1) {
					item.description = "(this project)"
				}
				items.push(item)
			}
		}

		//sort alphabetically
		items.sort((a, b) => { return (a.label! > b.label!) ? 1 : -1 })

		return items
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
		// if (element.contextValue == "library") {
		// 	element.description = "/items/main.tcil"
		// } else if (element.contextValue == "item") {
		// 	element.iconPath = vscode.Uri.parse("https://minecraft.wiki/images/Golden_Apple_JE2_BE2.png?f4719")
		// 	element.description = "'Golden Apple' x1"
		// }
		return element
	}

	private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  	readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}
}

async function updateLibrary(fileURL: URL, projectURL: URL) {
	function remove() {
		let fileString = fileURL.toString()
		let projectString = projectURL.toString()
		if (fileString in urlStringToLibMap) {
			let entry = urlStringToLibMap[fileURL.toString()]!

			delete itemLibraries[projectString]![entry.id]
			delete urlStringToLibMap[fileString]
			stopEditing(projectString,entry.id)
		}
		itemEditorProvider.refresh()
	}

	let contents: Buffer 
	try {
		contents = await fs.readFile(fileURL)
	} catch {
		remove()
		return
	}

	let parsed: any
	try {
		parsed = JSON.parse(contents.toString())
	} catch (e) {
		vscode.window.showErrorMessage(`Malformed item library at ${fileURLToPath(fileURL)}: ${e} (malformed JSON). This library will not be loaded.`)
		remove()
		return
	}

	//error if library is missing a field
	for (const field of ["id","items","compilationMode"]) {
		if (!(field in parsed)) {
			vscode.window.showErrorMessage(`Malformed item library at ${fileURLToPath(fileURL)}: Missing '${field}' field. This library will not be loaded.`)
			remove()
			return
		}
	}

	//handle library file changing its id
	if (fileURL.toString() in urlStringToLibMap && urlStringToLibMap[fileURL.toString()]?.id != parsed.id) {
		let oldId = urlStringToLibMap[fileURL.toString()]!.id
		delete itemLibraries[projectURL.toString()]![oldId]
		stopEditing(projectURL.toString(),oldId)
	}

	//error for if there is already a library with this id
	if (parsed.id in itemLibraries[projectURL.toString()]! && itemLibraries[projectURL.toString()]![parsed.id]!.fileURL.toString() != fileURL.toString()) {
		vscode.window.showErrorMessage(`Multiple item libraries with id '${parsed.id}' in project ${fileURLToPath(projectURL)}.\n${fileURLToPath(itemLibraries[projectURL.toString()]![parsed.id]!.fileURL)}\n${fileURLToPath(fileURL)}`)
		return
	}

	//if this library's id has changed, remove the old id from the master map
	let oldEntry = urlStringToLibMap[fileURL.toString()]!
	if (oldEntry && parsed.id != oldEntry) {
		delete itemLibraries[projectURL.toString()]![oldEntry.id]
	}

	//if any items were renamed or removed from this library, stop editing them
	let seenItemIds: Dict<true> = {}
	for (const itemId of Object.keys(parsed.items)) {
		seenItemIds[itemId] = true
	}
	if (itemsBeingEdited[projectURL.toString()]?.[parsed.id]) {
		for (const itemId of Object.keys(itemsBeingEdited[projectURL.toString()]![parsed.id]!)) {
			if (!(itemId in seenItemIds)) {
				stopEditing(projectURL.toString(),parsed.id,itemId)
			}
		}
	}
	

	//fill new data into slot
	let entry = {
		id: parsed.id,
		items: parsed.items,
		compilationMode: parsed.compilationMode,
		fileURL: fileURL,
		projectURL: projectURL
	}

	itemLibraries[projectURL.toString()]![parsed.id] = entry
	urlStringToLibMap[fileURL.toString()] = entry
}

async function saveLibrary(library: ItemLibraryFile) {
	await fs.writeFile(library.fileURL,stableStringify({
		id: library.id,
		items: library.items,
		compilationMode: library.compilationMode,
		lastEditedWithExtensionVersion: EXTENSION_VERSION,
	},{ space: '  ' }))
}

//i am way too lazy to seperate the validation and parsing into seperate functions
function parseMaterial(value: string): any {
	let material: string = value
	let nbt: NBTTypes.CompoundTag | undefined
	
	// don't feel like updating this to 1.21 since its a whole new syntax \\
	
	// //try for material{nbt} format
	// let regexResult = [...value.matchAll(/^(.+?)({.*})\s*$/g)]
	// if (regexResult.length > 0) {
	// 	material = regexResult[0][1]
	// 	//validate nbt
	// 	try {
	// 		nbt = NBT.parse<NBTTypes.CompoundTag>(regexResult[0][2])
	// 		let finishedItem = NBT.parse("{}") as any
	// 		finishedItem.id = material
	// 		finishedItem.components = nbt
	// 		let validation = validateItemData(finishedItem)
	// 		if (validation !== true) {
	// 			throw validation
	// 		}
	// 	} catch (e) {
	// 		throw `Malformed item data: ${e}`
	// 	}
	// }

	//try {id:"",tag:{}} format
	let regexResult = [...value.matchAll(/^\s*({.*})\s*$/g)]
	if (regexResult.length > 0) {
		try {
			let parsed = NBT.parse<NBTTypes.CompoundTag>(regexResult[0][1])
			let validation = validateItemData(parsed)
			if (validation !== true) {
				throw validation
			}
			nbt = parsed.components as NBTTypes.CompoundTag
			material = parsed.id as string
		} catch (e) {
			throw `Malformed item data: ${e}`
		}
	}

	

	
	if (material.length == 0) { return undefined }
	
	//chop off minecraft namespace from material if present
	if (material.startsWith("minecraft:")) {
		material = material.substring("minecraft:".length) //yeahj im too lazy to count
	}
	
	//validate material
	if (!(material in validItemIds)) {
		throw `Invalid material '${material}'`
	}

	if (nbt == undefined) {nbt = NBT.parse<NBTTypes.CompoundTag>("{}")}

	return [material, nbt]
}

//leave itemId blank to stop editing an entire library
function stopEditing(project: string, libraryId: string, itemId: string | undefined = undefined) {
	if (itemsBeingEdited[project]?.[libraryId]) {

		//remove item
		if (itemId) {
			//remove library
			delete itemsBeingEdited[project][libraryId][itemId]

			//if the library now has no items being edited, remove it
			if (Object.keys(itemsBeingEdited[project][libraryId]).length == 0) {
				delete itemsBeingEdited[project][libraryId]
			}
		//remove library directly
		} else {
			delete itemsBeingEdited[project][libraryId]
		}
		
		
		//if the project now has no libraries being edited, remove it
		if (Object.keys(itemsBeingEdited[project]).length == 0) {
			delete itemsBeingEdited[project]
		}
	}
}

function stopEditingAllItems() {
	// when switching out of dev mode, stop editing all items
	for (const [project, libraries] of Object.entries(itemsBeingEdited)) {
		for (const libraryId of Object.keys(libraries!)) {
			stopEditing(project,libraryId)
		}
	}
	itemEditorProvider.refresh()
}

//if it returns a string, that means the item id is invalid
function validateItemId(itemId: string, library: ItemLibraryFile): string | true {
	let regexResult = [...itemId.matchAll(/^[a-z0-9_\-./]*([^a-z0-9_\-./]|$)/g)]
	if (regexResult[0][1]) {
		return `Invalid character for item id: '${regexResult[0][1]}' (valid characters are lowercase 'a-z', '0-9', '/', '.', '_', and '-')`
	}
	
	if (itemId in library.items) {
		return `Item with id '${itemId}' already exists in library '${library.id}'`
	}

	return true
}

function validateItemData(item: any) {
	if (!("id" in item)) {
		return `Item has no id field.`
	}

	if (!(item.id?.toString() === item.id)) {
		return `Id field must be string.`
	}

	if ("components" in item) {
		if (NBT.getTagType(item.components) !== NBT.TAG.COMPOUND) {
			return `Components field must be compound tag.`
		}
		if (item.components["minecraft:custom_data"]?.PublicBukkitValues?.["hypercube:varitem"]) {
			return `This item is a code value and cannot be saved to libraries.`
		}
	}


	return true
}

/**
 * this will NOT save the library OR update the treeview, its only job is to handle
 * modifying item data and adding it to the internal library structure
 * @param item this item's data will NOT be modified
 */
function addItemDataToLibrary(library: ItemLibraryFile, itemId: string, item: any) {
	item = NBT.parse(NBT.stringify(item))

	//remove fields that don't need to be saved
	let customData = item.components?.["minecraft:custom_data"]
	if (customData) {
		if ("terracottaEditorItem" in customData) {
			delete customData.terracottaEditorItem
		}
		if ("PublicBukkitValues" in customData) {
			if ("hypercube:__tc_ii_import" in customData.PublicBukkitValues) {
				delete customData.PublicBukkitValues["hypercube:__tc_ii_import"]
			}
			if (Object.keys(customData.PublicBukkitValues).length == 0) {
				delete customData.PublicBukkitValues
			}
		}

		if (Object.keys(customData).length == 0) {
			delete item.components["minecraft:custom_data"]
		}
	}
	if (!item.id.startsWith("minecraft:")) {
		item.id = "minecraft:" + item.id
	}
	delete item.count
	delete item.Slot

	//add new data to library
	library.items[itemId] = {
		version: DF_NBT,
		data: NBT.stringify(item)
	}
}

let lastMode: string | undefined
async function syncInventory() {
	if (codeClientTask != "idle") { return }
	if (!codeClientAuthed) { return }

	//only do inv syncing while in dev
	let mode = await getCodeClientMode()
	if (mode != "code") {
		stopEditingAllItems()

		//if auth is removed by the player
		//this shouldn't be in the inv syncing function but i do not care
		if (mode == "unknown") {
			codeClientAuthed = false
		}

		//if just switching out of dev, stop editing all items
		if (lastMode == "code") {
			itemsBeingEdited = {}
		}
		return
	}

	let inventory = await getCodeClientInventory()
	let modifiedLibraries: Map<ItemLibraryFile, true> = new Map()
	let editingItemsInInventory: Dict<Dict<Dict<boolean>>> = {} //works the same as itemsBeingEdited

	let invIndiciesToRemove: number[] = []
	//first and second layer dicts are project and library id respectively
	//key: item id = data if the item shoudl be updated, number representing what slot to remove if not
	let itemsToUpdate: Dict<Dict<Dict<any>>> = {}
	let itemIdSlots: Dict<number[]> = {}
	let itemsWereModified = false

	let i = -1
	for (const item of inventory) {
		i++
		let tags = item.components?.["minecraft:custom_data"]?.PublicBukkitValues
		let editorData = item.components?.["minecraft:custom_data"]?.terracottaEditorItem
		//editor item
		if (editorData && "itemid" in editorData && "libid" in editorData && "project" in editorData) {
			let project = editorData["project"]
			let libraryId = editorData["libid"]
			let itemId = editorData["itemid"]

			//if this is an editor item but its not for anything thats actually being edited, mark it for removal
			if (!itemsBeingEdited?.[project]?.[libraryId]?.[itemId]) {
				invIndiciesToRemove.push(i)
				continue
			}

			//add to editingItemsInInventory list
			ensurePathExistance(editingItemsInInventory, project, libraryId)[itemId] = true
			//add to itemsToUpdate list
			ensurePathExistance(itemsToUpdate, project, libraryId)

			//if the same item is present in the inventory multiple times, don't let it be updated
			if (itemId in itemsToUpdate[project]![libraryId]!) {
				itemsToUpdate[project]![libraryId]![itemId] = false
			} else {
				itemsToUpdate[project]![libraryId]![itemId] = item
				itemIdSlots[itemId] = []
			}

			itemIdSlots[itemId]!.push(i)
		}
		//importer item
		else if (tags && "hypercube:__tc_ii_import" in tags) {
			//import item
			if (itemImportId && tags["hypercube:__tc_ii_import"] == itemImportId) {
				if (returnItemBeingImported) {
					returnItemBeingImported(item)
				}
			}
			//this item's import data doesn't match the current id and is useless
			//so the tag should be removed to avoid cluttering the item's nbt
			else {
				itemsWereModified = true
				delete tags["hypercube:__tc_ii_import"]
			}
		}
	}

	//update items
	for (const [project, libraries] of Object.entries(itemsToUpdate)) {
		for (const [libraryId, items] of Object.entries(libraries!)) {
			for (const [itemId, item] of Object.entries(items!)) {
				//this means the item shouldn't be updated for whatever reason
				if (item == false) {
					invIndiciesToRemove.push(...itemIdSlots[itemId]!)
				}
				//actually save the item's changes
				else {
					let library = itemLibraries[project]![libraryId]!

					try {
						addItemDataToLibrary(library, itemId, item)
					} catch (e) {
						vscode.window.showErrorMessage("Could not add item", {
							modal: true,
							detail: `${e}`
						})
					}

					modifiedLibraries.set(library, true)
				}
			}
		}
	}

	//unmark items as being edtied if they have been removed from the inventory
	let itemsWereRemoved = false
	for (const [project, libraries] of Object.entries(itemsBeingEdited)) {
		for (const [libraryId, items] of Object.entries(libraries!)) {
			for (const itemId of Object.keys(items!)) {
				if (!editingItemsInInventory[project]?.[libraryId]?.[itemId]) {
					itemsWereRemoved = true
					stopEditing(project, libraryId, itemId)
				}
			}
		}
	}

	//remove editor items that aren't actively being edited
	if (invIndiciesToRemove.length > 0) {
		itemsWereModified = true
		invIndiciesToRemove.forEach(i => inventory[i] = undefined) //set all slots marked for removal as undefined
		inventory.filter(e => e) //actually remove undefined slots from the array
	}

	//save libraries
	for (const library of modifiedLibraries.keys()) {
		await saveLibrary(library)
	}

	//only bother updating if stuff actually changed
	if (itemsWereModified || itemsWereRemoved) {
		itemEditorProvider.refresh()
	}
	if (itemsWereModified) {
		codeclientMessage("setinv " + NBT.stringify(inventory))
	}
}

//returns `true` 
async function requireCodeClientConnection(refusalMessage: string, requiredMode: "code" | undefined = undefined): Promise<boolean> {
	if (!codeClientConnected) {
		vscode.window.showErrorMessage(`${refusalMessage} because Terracotta could not connect to CodeClient.`,{},"Retry CodeClient Connection").then(value => {
			if (value == "Retry CodeClient Connection") {
				setupCodeClient()
			}
		})
		return false
	} else if (!codeClientAuthed) {
		vscode.window.showErrorMessage(`${refusalMessage} because Terracotta lacks CodeClient permissions. Try running /auth in Minecraft.`)
		return false
	}
	if (requiredMode !== undefined) {
		let currentMode = await getCodeClientMode()
		if (currentMode != requiredMode) {
			vscode.window.showErrorMessage(`${refusalMessage} because you are not in ${requiredMode == "code" ? "dev" : requiredMode} mode.`)
			return false
		}
	}
	return true
}


async function startItemLibraryEditor(context: vscode.ExtensionContext) {
	//i just set a new personal best for ugliest for loops ever written
	for (const id of JSON.parse((await fs.readFile(new URL((context.extensionUri + "/assets/data/valid_item_ids.json").toString()))).toString())) {
		validItemIds[id] = true
	}
	for (const [id, link] of Object.entries(JSON.parse((await fs.readFile(new URL((context.extensionUri + "/assets/data/item_icons.json").toString()))).toString()))) {
		itemIcons[id as string] = link as string
	}

	//item editor can only work in a workspace
	if (vscode.workspace.workspaceFolders == undefined) { return }

	//launch provider
	itemEditorProvider = new ItemLibraryEditorProvider(context)
	vscode.window.registerTreeDataProvider('terracotta.itemLibraryEditor', itemEditorProvider);

	let itemImportQuickPick: vscode.QuickPick<vscode.QuickPickItem> | undefined

	//= set up file system watchers =\\
	const tcilWacther = vscode.workspace.createFileSystemWatcher("**/**.tcil")
	
	async function onTcilChanged(fileURI: vscode.Uri) {
		if (!vscode.workspace.workspaceFolders) { return }

		let folderURI: vscode.Uri | undefined
		for (const folder of vscode.workspace.workspaceFolders) {
			if (fileURI.toString().startsWith(folder.uri.toString())) {
				folderURI = folder.uri
				break
			}
		}

		//how
		if (folderURI == undefined) { return }

		await updateLibrary(new URL(fileURI.toString()),new URL(folderURI.toString()))
		itemEditorProvider.refresh()
	}

	tcilWacther.onDidChange(onTcilChanged)
	tcilWacther.onDidCreate(onTcilChanged)
	tcilWacther.onDidDelete(onTcilChanged)

	//= start tracking all existing tcil files =\\
	async function recurse(folderURL: URL, projectURL: URL) {
		try { await fs.access(folderURL)} catch { return }

		let contents
		try {
			contents = await fs.readdir(folderURL)
		} catch { return }
		for (const filePath of contents) {
			let fileURL = new URL(folderURL.toString() + "/" + filePath)

			try { await fs.access(fileURL)} catch (e) { console.log(e); continue }

			let info = await fs.stat(fileURL)
			if (info.isDirectory()) {
				await recurse(fileURL,projectURL)
			} else {
				if (filePath.endsWith(".tcil")) {
					//load its current state
					await updateLibrary(fileURL,projectURL)
				}
			}
		}
	}

	for (const folder of vscode.workspace.workspaceFolders) {
		let url = new URL(folder.uri.toString())
		itemLibraries[url.toString()] = {}
		await recurse(url,url)
	}
	areLibrariesLoaded = true
	itemEditorProvider.refresh()

	//= start inventory synchronizer =\\
	setInterval(syncInventory, 1000);
	

	
	//= commmands =\\
	vscode.commands.registerCommand("extension.terracotta.itemEditor.showMigrationInfo",async (treeItem: ItemTreeItem) => {
		vscode.window.showInformationMessage("Item Migration Help",{
			detail: "This item was saved for an older version of minecraft. It can still be used in your code but cannot be edited in minecraft until it is migrated.",
			modal: true,
		})
	})

	vscode.commands.registerCommand("extension.terracotta.itemEditor.openFile",async (treeItem: vscode.TreeItem) => {
		if (treeItem instanceof LibraryTreeItem) {
			vscode.window.showTextDocument(vscode.Uri.parse(treeItem.library.fileURL.toString()))
		}
	})

	vscode.commands.registerCommand("extension.terracotta.itemEditor.copyItemConstructor",(treeItem: ItemTreeItem) => {
		vscode.env.clipboard.writeText(`litem["${treeItem.library.id.replaceAll('"','\\"')}", "${treeItem.itemId.replaceAll('"','\\"')}"]`)
	})

	vscode.commands.registerCommand("extension.terracotta.itemEditor.giveStaticCopy",async (treeItem: ItemTreeItem) => {
		if (!await requireCodeClientConnection("Item cannot be given","code")) {return}

		let item = NBT.parse(treeItem.library.items[treeItem.itemId].data) as any
		item.Count = new NBT.Int8(1)
		codeclientMessage(`give ${NBT.stringify(item)}`)
	})

	vscode.commands.registerCommand("extension.terracotta.itemEditor.delete",async (treeItem: vscode.TreeItem) => {
		//figure out whether its a library or an item being deleted
		let id: string
		if (treeItem instanceof LibraryTreeItem) {
			id = treeItem.library.id
		} else if (treeItem instanceof ItemTreeItem) {
			id = treeItem.itemId
		} else {
			return
		}

		const prompt = `Please re-type this ${treeItem instanceof ItemTreeItem ? "item" : "library"}'s id ('${id}') to delete it`
		
		//make user re-type id to confirm deletion
		const input = await vscode.window.showInputBox({
			title: `${treeItem instanceof ItemTreeItem ? "Item" : "Library"} Deletion Confirmation`,
			placeHolder: id,
			prompt: prompt,
			validateInput: value => {
				if (value != id) {
					return {
						message: prompt,
						severity: vscode.InputBoxValidationSeverity.Error
					}
				} else {
					return {
						message: treeItem instanceof ItemTreeItem ? `Press enter to PERMANENTLY DELETE item '${id}' from library '${treeItem.library.id}'` :
								 `Press enter to PERMANENTLY DELETE library '${treeItem.library.id}'`,
						severity: vscode.InputBoxValidationSeverity.Warning
					}
				}
			}
		})

		if (input != id) {return}

		//actually do the deleting
		if (treeItem instanceof LibraryTreeItem) {
			await fs.rm(treeItem.library.fileURL)
			await updateLibrary(treeItem.library.fileURL,treeItem.library.projectURL)
		} else if (treeItem instanceof ItemTreeItem) {
			delete treeItem.library.items[treeItem.itemId]
			await saveLibrary(treeItem.library)
		}
		itemEditorProvider.refresh()
	})

	vscode.commands.registerCommand("extension.terracotta.itemEditor.rename",async (treeItem: ItemTreeItem) => {
		let oldId: string = treeItem.itemId
		
		//ask for new id
		const newId = await vscode.window.showInputBox({
			title: `Rename ${treeItem instanceof ItemTreeItem ? "Item" : "Library"} '${oldId}'`,
			placeHolder: "New ID",
			validateInput: value => {
				let validation = validateItemId(value,treeItem.library)
				if (validation !== true) {
					return {
						message: validation,
						severity: vscode.InputBoxValidationSeverity.Error
					}
				}
			}
		})
		if (!newId) { return }

		//actual renaming
		treeItem.library.items[newId] = treeItem.library.items[oldId]
		delete treeItem.library.items[oldId]

		await saveLibrary(treeItem.library)
		itemEditorProvider.refresh()
	})

	vscode.commands.registerCommand("extension.terracotta.itemEditor.startEditingItem",async (treeItem: ItemTreeItem) => {
		if (!await requireCodeClientConnection("Item cannot be edited","code")) {return}

		let projectUrlString = treeItem.library.projectURL.toString()
		ensurePathExistance(itemsBeingEdited,projectUrlString,treeItem.library.id)[treeItem.itemId] = true


		let parsed: any
		try {
			parsed = NBT.parse(treeItem.library.items[treeItem.itemId].data)
		} catch (e) {
			vscode.window.showErrorMessage(`Could not edit item ${treeItem.itemId} because its data its invalid: ${e}`)
			return
		}

		//prepare item to be sent
		parsed.Count = new NBT.Int8(1)
		let editorData = ensurePathExistance(parsed,"components","minecraft:custom_data","terracottaEditorItem")
		editorData["itemid"]  = treeItem.itemId,
		editorData["libid"]   = treeItem.library.id,
		editorData["project"] = treeItem.library.projectURL.toString(),

		codeclientMessage(`give ${NBT.stringify(parsed)}`)
		itemEditorProvider.refresh()
	})

	vscode.commands.registerCommand("extension.terracotta.itemEditor.stopEditingItem",async (treeItem: ItemTreeItem) => {
		//save latest changes
		await syncInventory()
		
		//remove from currently editing list
		let projectUrlString = treeItem.library.projectURL.toString()
		stopEditing(projectUrlString,treeItem.library.id,treeItem.itemId)

		//remove from minecraft inventory
		let indiciesToRemove: number[] = []
		let inventory = await getCodeClientInventory()

		let i = -1;
		for (const item of inventory) {
			i++
			let editorData = item.components?.["minecraft:custom_data"]?.terracottaEditorItem
			if (editorData && "itemid" in editorData && "libid" in editorData && "project" in editorData){
				if (
					editorData["itemid"]  == treeItem.itemId &&
					editorData["libid"]   == treeItem.library.id &&
					editorData["project"] == treeItem.library.projectURL.toString()
				) {
					indiciesToRemove.unshift(i)
				}
			}
		}

		indiciesToRemove.forEach(i => inventory.splice(i,1))
		codeclientMessage("setinv "+NBT.stringify(inventory))
	})

	vscode.commands.registerCommand("extension.terracotta.itemEditor.importItemToLibrary",async (treeItem: LibraryTreeItem) => {
		if (!await requireCodeClientConnection("Items cannot be imported","code")) {return}

		let thisImportId = Math.floor(Math.random()*1000000)
		let itemRecieved = false
		itemImportId = thisImportId

		let itemDataPromise = new Promise<any | null>(resolve => {
			//if there was a previously active item data promise, kill it
			if (returnItemBeingImported) { returnItemBeingImported(null) }

			//shoving resolve functions out into the rest of the code is definitely a good idea
			returnItemBeingImported = resolve
		})

		//show command window
		let qp = vscode.window.createQuickPick()
		itemImportQuickPick = qp
		qp.items = [
			{
				label: "In Minecraft, hold the desired item and run the above command",
				alwaysShow: true,
				kind: vscode.QuickPickItemKind.Default,
			}
		]
		qp.value = `/i tag set __tc_ii_import ${itemImportId}`
		qp.enabled = false
		qp.ignoreFocusOut = true
		qp.busy = true
		qp.title = "Import Item from Minecraft"
		qp.selectedItems = []
		qp.activeItems = []
		qp.onDidHide(() => {
			if (itemRecieved === false) {
				itemImportId = undefined
				//cancel item resolve promise
				if (returnItemBeingImported) { returnItemBeingImported(null) }
			}
			qp.dispose()
		})
		qp.show()

		//wait for item to be imported
		let itemData = await itemDataPromise
		//make sure item is existant and valid
		if (itemData == null) { 
			qp.dispose()
			return 
		}
		let validation = validateItemData(itemData)
		if (validation !== true) {
			vscode.window.showErrorMessage("Item cannot be imported",{
				modal: true,
				detail: `${validation}`
			})
			qp.dispose()
			return
		}

		itemRecieved = true
		qp.dispose()

		

		//show id window
		const itemId = await vscode.window.showInputBox({
			title: "Import Item from Minecraft",
			ignoreFocusOut: true,
			placeHolder: "Enter Item ID",
			prompt: `Item will be added to library '${treeItem.library.id}'.`,
			validateInput: value => {
				let validation = validateItemId(value,treeItem.library)
				if (validation !== true) {
					return {
						message: validation,
						severity: vscode.InputBoxValidationSeverity.Error
					}
				}
			}
		})
		if (itemId == null) { return }


		try {
			addItemDataToLibrary(treeItem.library,itemId,itemData)
		} catch (e) {
			vscode.window.showErrorMessage("Could not import item",{
				modal: true,
				detail: `${e}`
			})
		}

		
		await saveLibrary(treeItem.library)
		itemEditorProvider.refresh()

		//if item was successfully added, remove from mc inv to avoid confusion
		//remove from minecraft inventory
		let indiciesToRemove: number[] = []
		let inventory = await getCodeClientInventory()

		let i = -1;
		for (const item of inventory) {
			i++
			let tags = item.components?.["minecraft:custom_data"]?.PublicBukkitValues
			if (tags && "hypercube:__tc_ii_import" in tags && tags["hypercube:__tc_ii_import"] == thisImportId){
				indiciesToRemove.unshift(i)
			}
		}

		indiciesToRemove.forEach(i => inventory.splice(i,1))
		codeclientMessage("setinv "+NBT.stringify(inventory))

		itemImportId = undefined
	})

	vscode.commands.registerCommand("extension.terracotta.itemEditor.addItemToLibrary",async (treeItem: LibraryTreeItem) => {
		const id = await vscode.window.showInputBox({
			title: `Add Item to Library '${treeItem.library.id}'`,
			placeHolder: "Item ID",
			ignoreFocusOut: true,
			validateInput: value => {
				let validation = validateItemId(value,treeItem.library)
				if (validation !== true) {
					return {
						message: validation,
						severity: vscode.InputBoxValidationSeverity.Error
					}
				}
			}
		})

		if (id == undefined || id.length == 0) {return}

		const rawMaterial = await vscode.window.showInputBox({
			title: `Add Item to Library '${treeItem.library.id}'`,
			placeHolder: "Item Data",
			ignoreFocusOut: true,
			prompt: "Accepts the following formats: material ids (cobblestone), or self-contained item nbt ({id:\"minecraft:iron_sword\",components:{damage:20}})",
			validateInput: value => {
				try { parseMaterial(value) }
				catch (e) {
					return {
						message: e as string,
						severity: vscode.InputBoxValidationSeverity.Error
					}
				}
			}
		})

		if (rawMaterial == undefined || rawMaterial.length == 0) { return }

		let materialResult = parseMaterial(rawMaterial)
		if (materialResult == null) {return}
		let [material, nbt] = materialResult

		let finishedItem = NBT.parse("{}") as any
		finishedItem.id = material
		finishedItem.components = nbt
		addItemDataToLibrary(treeItem.library,id,finishedItem)

		saveLibrary(treeItem.library)
	})

	vscode.commands.registerCommand("extension.terracotta.itemEditor.addLibraryToProject",async (treeItem: ProjectTreeItem) => {
		const id = await vscode.window.showInputBox({
			title: "Create New Item Library",
			placeHolder: "Library ID",
			ignoreFocusOut: true,
			validateInput: (value) => {
				if (value in itemLibraries[treeItem.path]!) {
					return {
						message: `Library with id '${value}' already exists`,
						severity: vscode.InputBoxValidationSeverity.Error
					}
				}
			}
		})

		if (id == undefined || id.length == 0) { return }

		const path = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.parse(treeItem.path + `/${id}`),
			saveLabel: "Create Here",
			filters: {
				"Item Library": ["tcil"]
			},
			title: "New Library Destination"
		})

		if (path == undefined) { return }
		let strPath = path.toString()
		if (!strPath.endsWith(".tcil")) {
			strPath += ".tcil"
		}
		let url = new URL(strPath)

		try {
			await fs.writeFile(url,JSON.stringify({
				"compilationMode": "item",
				"id": id,
				"items": {},
				"lastEditedWithExtensionVersion": EXTENSION_VERSION
			},null,4))
		} catch (e) {
			vscode.window.showErrorMessage(`Could not create item library: ${e}`)
		}
	})
}

async function startLanguageServer() {
	let server: cp.ChildProcess

	if (client) {
		client.stop()
	}

	// lmao i am so sorry
	let serverOptions: ServerOptions

	if (useSourceCode) {
		serverOptions = async function() {
			if (process.platform == "darwin") {
				if (useSourceCode) {
					server = cp.exec(`cd "${sourcePath}"; ~/.deno/bin/deno run --allow-read --allow-env "${mainScriptPath}" server`,{maxBuffer: Infinity})
				} else {
					server = cp.exec(`/tmp/terracotta\\ mac`)
				}
			}
			else if (process.platform == "win32") {
				//add windows support later
				
			}
			return Promise.resolve(server)
		}
	} else {
		serverOptions = {
			command: terracottaPath,
			args: ["server"]
		}
	}
				
	
	// Options to control the language client
	let clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'terracotta' }, { scheme: 'file', pattern: '**/*.tcil'}],
		synchronize: {
			fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{tc,tcil}')
		},
		outputChannel: outputChannel,
		outputChannelName: "terracotta"
	};

	try {
		//check to see that the install path is valid
		if (useSourceCode) {
			await fs.access(sourcePath, fs.constants.F_OK | fs.constants.R_OK | fs.constants.X_OK)
		} else {
			await fs.access(terracottaPath, fs.constants.F_OK | fs.constants.R_OK | fs.constants.X_OK)
		}
	} catch (e) {
		vscode.window.showErrorMessage(
			"Terracotta binary is missing or inaccessible.",
			{modal: true},
			"Change Terracotta Version"
		).then(chosen => {
			if (chosen == "Change Terracotta Version") {
				vscode.commands.executeCommand("extension.terracotta.changeVersion")
			}
		})
		return
	}

	console.log(terracottaPath)
	
	client = new LanguageClient(
		'terracotta',
		'Terracotta',
		serverOptions,
		clientOptions
	);
	client.start()
}

//==========[ extension events ]=========\

export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel("Terracotta LSP")
	outputChannel.show()
		
	versionManager = new VersionManager(context)
	updateTerracottaPath()
	setupCodeClient()
	startItemLibraryEditor(context)

	//= commands =\\
	vscode.commands.registerCommand("extension.terracotta.refreshCodeClient",() => {
		setupCodeClient();
	})

	vscode.commands.registerCommand("extension.terracotta.importCodeValue",async () => {
		if (!await requireCodeClientConnection("Values cannot be imported","code")) {return}
		
		let qp = vscode.window.createQuickPick()
		qp.title = "Item Converter"
		qp.placeholder = "Click on an item icon to convert it and copy it to the clipboard"
		qp.ignoreFocusOut = true
		qp.canSelectMany = false
		qp.onDidAccept(() => {
			npc.copy((qp.activeItems[0] as any).value)
			qp.dispose()
		})
		qp.items = (await getCodeClientInventory()).map(nbt => {
			const codeValueString = nbt.components?.["minecraft:custom_data"]?.["PublicBukkitValues"]?.["hypercube:varitem"]
			if (!codeValueString) { return null }
			
			let codeValue: any
			try {
				codeValue = JSON.parse(codeValueString)
			} catch (e) {return null}

			function convertString(s: string): string {
				return ('"' + s
					.replaceAll("\\","\\\\")
					.replaceAll('"','\\"')
					.replaceAll("\n","\\n")
					.replaceAll(/&(?=[abcdef0123456789lmnork])/g,"\&")
					.replaceAll(/§(?=[abcdef0123456789lmnork])/g,"&")
				+ '"')
			}

			function convertNumber(n: number): string {
				return (n
					.toFixed(3)
					.replace(/(?<!^)(?:\.|(?<=[^0]))0+$/,"") //remove trailing decimal places
				)
			}

			let converted: string
			let args = []
			switch (codeValue.id) {
				case "num":
					// %math expressions currently cannot be expressed in terracotta
					if (codeValue.data.name.includes("%")) {return null}
					converted = codeValue.data.name
					break
				case "txt": //string, NOT STYLED TEXT
					converted = convertString(codeValue.data.name)
					break
				case "comp": //styled text
					converted = "s"+convertString(codeValue.data.name)
					break
				case "loc":
					args = [
						convertNumber(codeValue.data.loc.x),
						convertNumber(codeValue.data.loc.y),
						convertNumber(codeValue.data.loc.z),
					]
					if (codeValue.data.loc.pitch !== 0 || codeValue.data.loc.yaw !== 0) {
						args.push(
							convertNumber(codeValue.data.loc.pitch),
							convertNumber(codeValue.data.loc.yaw),
						)
					}
					converted = `loc[${args.join(", ")}]`
					break
				case "vec":
					args = [
						convertNumber(codeValue.data.x),
						convertNumber(codeValue.data.y),
						convertNumber(codeValue.data.z),
					]
					converted = `vec[${args.join(", ")}]`
					break
				case "snd":
					let constructorType = codeValue.data.key ? "csnd" : "snd"
					args = [
						convertString(codeValue.data.key ?? codeValue.data.sound)
					]
					if (codeValue.data.vol !== 2 || codeValue.data.variant) {
						args.push(
							convertNumber(codeValue.data.pitch),
							convertNumber(codeValue.data.vol),
						)
						if (codeValue.data.variant) {
							args.push(convertString(codeValue.data.variant))
						}
					} else if (codeValue.data.pitch !== 1) {
						args.push(convertNumber(codeValue.data.pitch))
					}
					converted = `${constructorType}[${args.join(", ")}]`
					break
				case "part":
					let fields: {[key: string]: string} = {}
					const pdata = codeValue.data.data

					if (codeValue.data.cluster.amount !== 1) {
						fields.Amount = convertNumber(codeValue.data.cluster.amount)
					}
					if (codeValue.data.cluster.horizontal !== 0 || codeValue.data.cluster.vertical !== 0) {
						fields.Spread = `[${convertNumber(codeValue.data.cluster.horizontal)}, ${convertNumber(codeValue.data.cluster.vertical)}]`
					}

					if (pdata.material !== undefined) {
						fields.Material = convertString(pdata.material.toLowerCase())
					}

					if (pdata.roll !== undefined) {
						if (pdata.roll !== 0) {
							fields.Roll = convertNumber(pdata.roll)
						}
					}

					if (pdata.rgb !== undefined) {
						fields.Color = convertString("#"+pdata.rgb.toString(16).padStart(6,"0"))
						if (pdata.rgb_fade !== undefined) {
							fields["Fade Color"] = convertString("#"+pdata.rgb_fade.toString(16).padStart(6,"0"))
						}
						fields["Color Variation"] = convertNumber(pdata.colorVariation)
					}

					if (pdata.opacity !== undefined) {
						if (pdata.opacity !== 100) {
							fields.Opacity = convertNumber(pdata.opacity)
						}
					}

					if (pdata.size !== undefined) {
						if (pdata.size !== 1) {
							fields.Size = convertNumber(pdata.size)
						}
						if (pdata.sizeVariation !== 0) {
							fields["Size Variation"] = convertNumber(pdata.sizeVariation)
						}
					}

					if (pdata.x !== undefined) {
						if (pdata.x !== 1 || pdata.y !== 0 || pdata.z !== 0) {
							let args = [
								convertNumber(pdata.x),
								convertNumber(pdata.y),
								convertNumber(pdata.z),
							]
							fields.Motion = `vec[${args.join(", ")}]`
						}
						if (pdata.motionVariation !== 100) {
							fields["Motion Variation"] = convertNumber(pdata.motionVariation)
						}
					}

					if (Object.keys(fields).length > 0) {
						converted = `par[${convertString(codeValue.data.particle)}, {${Object.entries(fields).map(e => `"${e[0]}" = ${e[1]}`).join(", ")}}]`
					} else {
						converted = `par[${convertString(codeValue.data.particle)}]`
					}
					break
				case "var":
					let varScope = codeValue.data.scope == "unsaved" ? "global" : codeValue.data.scope
					let varName: string = codeValue.data.name
					if (varName.match(/[^A-Za-z0-9_]/)) {
						converted = `${varScope} [${convertString(varName)}]`
					} else {
						converted = `${varScope} ${varName}`
					}
					break
				case "pot":
					args = [
						convertString(codeValue.data.pot),
					]
					if (codeValue.data.amp != 0 || codeValue.data.dur != 1000000) {
						args.push(convertNumber(codeValue.data.amp+1))
						if (codeValue.data.dur != 1000000) {
							args.push(convertNumber(codeValue.data.dur))
						}
					}
					converted = `pot[${args.join(", ")}]`
					break
				default:
					return null
			}
			return {
				label: `$(dfcodeitem-${codeValue.id}) ${converted}`,
				value: converted
			} as vscode.QuickPickItem
		}).filter(v => v !== null)
		qp.show()
	})

	vscode.commands.registerCommand("extension.terracotta.changeVersion",() => {
		//key is the additional info that will be displayed next to the version
		let versionsToDisplay: {[key: string]: string} = {}
		for (const version of versionManager.downloadableVersions) {
			versionsToDisplay[version] = ""
			if (version == versionManager.latestDownloadableVersion) {
				versionsToDisplay[version] += " (latest release)"
			}
			if (!versionManager.installedVersions.has(version)) {
				versionsToDisplay[version] += " (not installed)"
			}
		}
		for (const version of versionManager.installedVersions) {
			if (!versionsToDisplay[version]) {
				versionsToDisplay[version] = ""
			}
			if (version == getConfigValue("version")) {
				versionsToDisplay[version] += " (currently active)"
			} 
		}
		let qp = vscode.window.createQuickPick()
		let activeItems: vscode.QuickPickItem[] = []
		qp.items = Object.entries(versionsToDisplay).map(entry => {
			let item = {
				label: entry[0],
				description: entry[1],
			} as vscode.QuickPickItem
			if (entry[0] == getConfigValue("version")) {
				activeItems = [item]
			}
			return item
		}).sort((a,b) => compareVersions(a.label,b.label)).reverse()
		qp.show()
		qp.ignoreFocusOut = true
		qp.activeItems = activeItems
		qp.title = "Switch Terracotta Version"
		qp.placeholder = "Select a version to switch to. Versions will be downloaded automatically if needed."
		qp.onDidAccept(() => {
			qp.dispose()
			let item = qp.activeItems[0]
			if (!item) { return }
			let version = item.label

			//install version if not there
			if (!versionManager.installedVersions.has(version)) {
				let confirmationQp = vscode.window.createQuickPick()
				confirmationQp.items = [
					{"label": "Download","description": "Download this version and switch to it."},
					{"label": "Cancel","description": "Cancel version switching."},
				]
				confirmationQp.title = "Download Confirmation"
				confirmationQp.placeholder = "This version must be downloaded and installed to use it."
				confirmationQp.show()
				confirmationQp.activeItems = []
				confirmationQp.onDidAccept(async () => {
					confirmationQp.dispose()
					if (confirmationQp.activeItems[0].label == "Download") {
						vscode.window.showInformationMessage(`Downloading Terracotta v${version}`)
						try {
							await versionManager.downloadVersion(version)
						} catch (e) {
							vscode.window.showErrorMessage(`${e}`,{modal: true})
						}
						vscode.window.showInformationMessage(`Successfully downloaded and switched to Terracotta v${version}`)
						if (getConfigValue("version") == version) {
							startLanguageServer()
						} else {
							vscode.workspace.getConfiguration("terracotta").update("version",version,vscode.ConfigurationTarget.Global)
						}
					}
				})
			} else {
				vscode.workspace.getConfiguration("terracotta").update("version",version,vscode.ConfigurationTarget.Global)
				vscode.window.showInformationMessage(`Switched to Terracotta v${version}`)
			}
		})
	})

	//= set up debugger =\\

	//split up all the async callbacks into their own group to avoid
	//async'ing all the syncronous ones
	vscode.debug.onDidReceiveDebugSessionCustomEvent(async event => {
		//i would use an ACTUAL REQUEST for this but theres not a callback for that 
		if (event.event == "requestInfo") {
			itemsBeingEdited = {}
			codeClientTask = "compiling"
			
			//then return the actual info
			event.session.customRequest("returnInfo",{
				scopes: await getCodeClientScopes(),
				mode: await getCodeClientMode(),
				terracottaInstallPath: useSourceCode ? sourcePath : terracottaPath,
				useSourceCode: useSourceCode
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
		stopEditingAllItems()
	})

	vscode.debug.onDidTerminateDebugSession(session => {
		codeClientTask = "idle"
		delete debuggers[session.id]
	})

	//= settings response =\\
	vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration("terracotta.version") || event.affectsConfiguration("terracotta.installPath") || event.affectsConfiguration("terracotta.useSourceCode") || (useSourceCode && event.affectsConfiguration("terracotta.sourcePath"))) {
			updateTerracottaPath()
			startLanguageServer()
		}
	})

	//= set up language server =\\
	startLanguageServer()
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined
	}
	console.log("DEACTIVATE")
	return client.stop()
}