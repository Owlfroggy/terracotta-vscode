import * as cp from "child_process";
import * as path from "path"
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, StreamMessageReader } from 'vscode-languageclient/node';
import * as fs from "fs/promises"
import * as os from "os"
import { fileURLToPath, pathToFileURL, URL } from "url";
import { Dict } from "./util/dict"
import * as npc from "copy-paste"
import * as crypto from "node:crypto"
const stableStringify = require("json-stable-stringify")
//why can't you just import like a normal????
import * as NBTTypes from "nbtify"
const NBT: typeof NBTTypes = require("fix-esm").require("nbtify");
import { VersionManager } from "./versionManager";
import { compareVersions } from "./util/compareVersions";
import * as TCClient from "./terracottaClientManager";

//the current DF_NBT value df uses. keeping this updated is required
//to make sure item data doesnt break between minecraft versions
const DF_NBT = 4440
const EXTENSION_VERSION = "0.0.6"

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

let versionManager: VersionManager

//==========[ file paths ]=========\

const delimiter = process.platform == "win32" ? "\\" : "/"
// Change .split("/") to split on both forward and backward slashes
let splitPath = __dirname.split(/[/\\]/)
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

//==========[ item library editor ]=========\

interface ItemLibraryFile {
	id: string,
	items: {[key: string]: {version: number, data: string, image?: string}},
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

					if (data.image && data.image != "error") {
						item.iconPath = vscode.Uri.parse(data.image);
					}

					// parse item data
					// let parsedData: NBTTypes.RootTagLike | undefined
					// try {
					// 	parsedData = NBT.parse(data.data)
					// } catch {}

					// //display as an error if the item data is malformed
					// if (!parsedData || !("version" in data) || !("id" in parsedData) || !(typeof parsedData.id === 'string' || parsedData.id instanceof String)) {
					// 	item.contextValue = "invalidItem",
					// 	item.description  = "ERROR ❌"
					// 	item.iconPath = vscode.Uri.joinPath(this.context.extensionUri,"/assets/icons/invalid_item.svg")
					// } 
					// else {
					// 	//handle different data versions
					// 	if (data.version != DF_NBT) {
					// 		item.contextValue = "outdatedItem"
					// 		item.description = "(needs migration)"
					// 	}
					// 	//if item is completely valid, set icon info based on parsed item id
					// 	let itemId = parsedData.id as string
					// 	if (itemId.startsWith("minecraft:")) {
					// 		itemId = itemId.substring("minecraft:".length)
					// 	}
					// 	if (itemId in itemIcons) {
					// 		item.iconPath = vscode.Uri.parse(itemIcons[itemId]!)
					// 	}
					// }
					
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
			stopEditingLocally(projectString,entry.id)
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
		stopEditingLocally(projectURL.toString(),oldId)
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
				stopEditingLocally(projectURL.toString(),parsed.id,itemId)
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
function stopEditingLocally(project: string, libraryId: string, itemId: string | undefined = undefined) {
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
			stopEditingLocally(project,libraryId)
		}
	}
	itemEditorProvider.refresh()
}

//if it returns a string, that means the item id is invalid
function validateItemId(itemId: string, library: ItemLibraryFile, extraTakenIds?: string[]): string | true {
	let regexResult = [...itemId.matchAll(/^[a-z0-9_\-./]*([^a-z0-9_\-./]|$)/g)]
	if (regexResult[0][1]) {
		return `Invalid character for item id: '${regexResult[0][1]}' (valid characters are lowercase 'a-z', '0-9', '/', '.', '_', and '-')`
	}
	
	if (itemId in library.items || (extraTakenIds != undefined && extraTakenIds.includes(itemId))) {
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
function addItemDataToLibrary(library: ItemLibraryFile, itemId: string, snbt: string) {
	if (itemId in library.items) {
		library.items[itemId].version = DF_NBT;
		library.items[itemId].data = snbt;
	} else {
		library.items[itemId] = {
			version: DF_NBT,
			data: snbt
		}
	}
}

function refreshLibraryItemImage(library: ItemLibraryFile, itemId: string) {
	//TODO: require tcclient connection
	//TODO: check DF_NBT
	if (!(itemId in library.items)) return;
	let item = library.items[itemId];
	TCClient.sendRequest(new TCClient.RenderItemA2CRequest(item.data),async (_, response: TCClient.RenderItemA2CResponse) => {
		if (response instanceof TCClient.ErrorResponse) return;
		item.image = response.image;
		await saveLibrary(library);
	})
}



//returns `true` 
async function erequireTCClientConnection(action: string): Promise<boolean> {
	if (!TCClient.isConnected) {
		vscode.window.showErrorMessage(`Could not ${action} because Terracotta is not connected to Minecraft.`,{},"Retry Connection").then(value => {
			if (value == "Retry Connection") {
				TCClient.tryConnection()
			}
		})
		return false
	} else if (!TCClient.isAuthed) {
		vscode.window.showErrorMessage(`Coold not ${action} because Terracotta lacks permissions. Try authenticating it in your Minecraft client.`)
		return false
	}
	return true
}

/**
 * Sends error notification if response is an error response
 * msg format: Could not ${action}: ${error message} (${error code})
 * @param response The response to check
 * @returns True if the response was an error, false otherwise
 */
function handleErrorResponse(response: TCClient.Response, action: string): boolean {
	if (response instanceof TCClient.ErrorResponse) {
		if (response.errorCode == "NO_PERMISSION") {
			vscode.window.showErrorMessage(
				`Could not ${action} due to missing permissions: ${response.errorMessage}\nIf this issue persists, try refreshing authentication.`,
				{detail: "Error"},
				"Refresh Authentication"
			).then(v => {
				if (v == "Refresh Authentication") {
					vscode.commands.executeCommand("extension.terracotta.refreshAuthentication")
				}
			});
		} else if (response.errorCode == "NOT_CONNECTED") {
			vscode.window.showErrorMessage(`Could not ${action} because Terracotta is not connected to Minecraft. If Minecraft is running and the mod is installed, try refreshing.`,{},"Refresh Connection").then(value => {
				if (value == "Refresh Connection") {
					TCClient.tryConnection()
				}
			})
		} else {
			vscode.window.showErrorMessage(
				`Could not ${action}: ${response.errorMessage} (code: ${response.errorCode})`,
				{detail: "Error"},
			);
		}

		return true;
	} else {
		return false;
	}
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

	//= tcclient integration =\\
	TCClient.onNotification(async notif => {
		if (notif instanceof TCClient.StopEditingItemC2ANotification) {
			stopEditingLocally(notif.workspacePath,notif.libraryId,notif.itemId)
			itemEditorProvider.refresh();
		}
		else if (notif instanceof TCClient.ItemChangedC2ANotification) {
			let library = itemLibraries[notif.workspacePath]![notif.libraryId]!
			if (!library) return;
			try {
				addItemDataToLibrary(library, notif.itemId, notif.snbt)
			} catch (e) {
				vscode.window.showErrorMessage("Could not add item", {
					modal: true,
					detail: `${e}`
				})
			}

			await saveLibrary(library)
		}
		else if (notif instanceof TCClient.ItemImageChangedC2ANotification) {
			let library = itemLibraries[notif.workspacePath]![notif.libraryId]!
			if (!library) return;
			try {
				let item = library.items[notif.itemId];
				item.image = notif.image;
				await saveLibrary(library)
			} catch (e) {}
		}
	})
	
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
		let response = await TCClient.sendRequestAsync(new TCClient.GiveItemA2CRequest(
			treeItem.library.items[treeItem.itemId].data,
			treeItem.library.items[treeItem.itemId].version)
		);
		handleErrorResponse(response, "give item");
	})

	vscode.commands.registerCommand("extension.terracotta.itemEditor.delete",async (treeItem: vscode.TreeItem) => {
		//figure out whether its a library or an item being deleted
		let id: string
		if (treeItem instanceof LibraryTreeItem) {
			id = treeItem.library.id
		} else if (treeItem instanceof ItemTreeItem) {
			id = treeItem.itemId
			if (itemsBeingEdited?.[treeItem.library.projectURL.toString()]?.[treeItem.library.id]?.[id]) {
				vscode.window.showErrorMessage(`Cannot delete item '${id}' while it's being edited in Minecraft.`)
				return;
			}
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
			if (itemsBeingEdited?.[treeItem.library.projectURL.toString()]?.[treeItem.library.id]?.[treeItem.itemId]) {
				vscode.window.showErrorMessage(`Cannot delete item '${id}' while it's being edited in Minecraft.`)
				return;
			}
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
		let response = await TCClient.sendRequestAsync(new TCClient.StartEditingItemA2CRequest(
			treeItem.library.projectURL.toString(),
			treeItem.library.id,
			treeItem.itemId,
			treeItem.library.items[treeItem.itemId].data,
			5 // TODO: THIS DOESNT WORK!!
		));

		if (handleErrorResponse(response, "edit library item")) return;

		let projectUrlString = treeItem.library.projectURL.toString()
		ensurePathExistance(itemsBeingEdited,projectUrlString,treeItem.library.id)[treeItem.itemId] = true

		itemEditorProvider.refresh()
	})

	vscode.commands.registerCommand("extension.terracotta.itemEditor.stopEditingItem",async (treeItem: ItemTreeItem) => {
		let projectUrlString = treeItem.library.projectURL.toString()
		stopEditingLocally(projectUrlString,treeItem.library.id,treeItem.itemId);
		TCClient.sendRequest(
			new TCClient.StopEditingItemA2CRequest(projectUrlString,treeItem.library.id,treeItem.itemId)
		);
	})

	vscode.commands.registerCommand("extension.terracotta.itemEditor.importItemToLibrary",async (treeItem: LibraryTreeItem) => {
		// if (!await requireCodeClientConnection("Items cannot be imported","code")) {return}

		let invResponse: TCClient.GetInventoryA2CResponse = await TCClient.sendRequestAsync(new TCClient.GetInventoryA2CRequest(true));

		if (handleErrorResponse(invResponse, "import items")) return;
		
		let qp = vscode.window.createQuickPick();
		let qpItemSnbts: Map<vscode.QuickPickItem, string> = new Map();
		let qpItemLibIds: Map<vscode.QuickPickItem, string> = new Map();

		let activeItems: readonly vscode.QuickPickItem[] = [];

		let renderedSeperators: Set<string> = new Set();

		let importSeperator: vscode.QuickPickItem = {label: "[Click to finalize import]", kind: vscode.QuickPickItemKind.Separator};
		let importButton: vscode.QuickPickItem = {label: "", alwaysShow: true};
		let qpItems: vscode.QuickPickItem[] = [importSeperator,importButton];
		for (const [slotStringified, item] of Object.entries(invResponse.items)) {
			let slot = Number(slotStringified);
			let category = (
				slot < 9 ? "Hotbar" :
				slot < 36 ? "Inventory" :
				slot < 40 ? "Armor" :
				"Offhand"
			)
			if (!renderedSeperators.has(category)) {
				qpItems.push({
					label: "from "+category,
					kind: vscode.QuickPickItemKind.Separator,
				})
				renderedSeperators.add(category);
			}

			let qpItem: vscode.QuickPickItem = {
				label: item.name,
			};
			qpItems.push(qpItem);
			qpItemSnbts.set(qpItem, item.snbt);
		}
		function showMainQp() {
			//update import button
			if (qpItemLibIds.size > 0) {
				importButton.label = `$(pass-filled) Import ${qpItemLibIds.size} item${qpItemLibIds.size == 1 ? "" : "s"} into library '${treeItem.library.id}'`
				importButton.kind = vscode.QuickPickItemKind.Default;
			} else {
				importButton.kind = vscode.QuickPickItemKind.Separator;
			}
			//actually show the thing
			qp.items = qpItems;
			qp.show();
			qp.activeItems = activeItems;
		}
		function updateQpItem(item: vscode.QuickPickItem) {
			let libId = qpItemLibIds.get(item);
			if (libId !== undefined) {
				item.detail = `Importing with id: '${libId}' (click to edit)`;
				item.description = "$(check)";
				item.buttons = [{iconPath: new vscode.ThemeIcon("close"), tooltip: "Don't import item"}];
			} else {
				item.detail = ``;
				item.description = "";
				item.buttons = [];
			}
		}
		function generateItemId(itemName: string) {
			let initialItemId = itemName.toLowerCase().replaceAll(/[^a-z0-9/._\- ]+/g,"").trim().replaceAll(" ","_");
			let existingIds = [...Object.keys(treeItem.library.items),...qpItemLibIds.values()];
			if (existingIds.includes(initialItemId)) {
				let num = 1;
				while (true) {
					num++;
					let itemId = initialItemId+"_"+num;
					if (!existingIds.includes(itemId)) return itemId;
				}
			} else {
				return initialItemId;
			}
		}
		qp.title = `Import Items from Inventory into '${treeItem.library.id}'`;
		qp.ignoreFocusOut = true;
		qp.placeholder = "Type to search inventory items, click items to import them";
		let addAllButton: vscode.QuickInputButton = {
			iconPath: new vscode.ThemeIcon("tasklist"),
			tooltip: "Add all items",
		};
		let clearAllButton: vscode.QuickInputButton = {
			iconPath: new vscode.ThemeIcon("clear-all"),
			tooltip: "Clear all items",
		};
		qp.buttons = [addAllButton, clearAllButton];
		qp.onDidTriggerButton(button => {
			for (const item of qp.items) {
				if (item.kind == vscode.QuickPickItemKind.Separator) continue;
				if (item == importButton) continue;

				if (button == addAllButton) {
					if (qpItemLibIds.has(item)) continue;
					qpItemLibIds.set(item, generateItemId(item.label));
					updateQpItem(item);
				}
				else if (button == clearAllButton) {
					if (!qpItemLibIds.has(item)) continue;
					qpItemLibIds.delete(item);
					updateQpItem(item);
				}
			}
			showMainQp();
		});
		qp.onDidChangeActive(e => {
			// if (qp.selectedItems.length  == 0) return;
			activeItems = e;
		});
		qp.onDidChangeSelection(async e => {
			if (qp.activeItems.length != 1) {
				if (qp.activeItems.length != 0) qp.activeItems = [];
				return;
			};
			let item = e[0];
			qp.hide();
			if (item == importButton) {
				// finalize import
				for (const [qpItem, libId] of qpItemLibIds) {
					try {
						let snbt = qpItemSnbts.get(qpItem)!;
						addItemDataToLibrary(treeItem.library,libId,snbt);
						refreshLibraryItemImage(treeItem.library,libId)
					} catch (e) {
						vscode.window.showErrorMessage("Could not import item",{
							modal: true,
							detail: `${e}`
						})
					}
				}

				
				await saveLibrary(treeItem.library)
				itemEditorProvider.refresh()
			} else {
				let generatedItemId = generateItemId(item.label);
				// edit item id / add to import
				let nameInput = vscode.window.createInputBox();
				if (qpItemLibIds.has(item)) {
					nameInput.value = qpItemLibIds.get(item)!;
				} else {
					nameInput.value = generatedItemId;
				}
				nameInput.title = `Import '${item.label}' into '${treeItem.library.id}'`;
				nameInput.ignoreFocusOut = true;
				nameInput.busy = true;
				nameInput.placeholder = generatedItemId;
				nameInput.prompt = "Enter item ID to reference this item by";
				nameInput.onDidChangeValue(e => {
					let validation = validateItemId(nameInput.value,treeItem.library,[...qpItemLibIds.values()])
					if (validation !== true) {
						nameInput.validationMessage = {
							message: validation,
							severity: vscode.InputBoxValidationSeverity.Error
						}
					} else {
						nameInput.validationMessage = undefined;
					}
				})
				nameInput.onDidAccept(val => {
					if (nameInput.validationMessage !== undefined) return;
					if (nameInput.value == "") return;
					qpItemLibIds.set(item, nameInput.value);
					nameInput.dispose();
					updateQpItem(item);
					showMainQp();
				});
				nameInput.onDidHide(_ => {
					showMainQp();
				})
				nameInput.show();
			}
		})
		qp.onDidTriggerItemButton(e => {
			qpItemLibIds.delete(e.item);
			updateQpItem(e.item);
			activeItems = [e.item];
			showMainQp();
		})
		showMainQp();
	});

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
		client.sendNotification("terracotta/exit");
		client.stop()
	}

	// lmao i am so sorry
	let serverOptions: ServerOptions

	if (useSourceCode) {
		serverOptions = async function() {
			if (process.platform == "darwin") {
				server = cp.exec(`cd "${sourcePath}"; ~/.deno/bin/deno run --allow-read --allow-env "${mainScriptPath}" server`,{maxBuffer: Infinity})
			}
			else if (process.platform == "win32") {
				//lil scuffed but it works so :thumbsup:
				const userProfile = process.env.USERPROFILE || process.env.HOMEPATH || "";
				const defaultDenoPath = path.join(userProfile, ".deno", "bin", "deno.exe");
				
				// Fall back to the global 'deno' command if the default path doesn't exist
				let denoCmd = `"${defaultDenoPath}"`;
				try {
					await fs.access(defaultDenoPath);
				} catch {
					denoCmd = "deno";
				}

				// Normalize paths to turn double backslashes into valid single backslashes for cmd.exe
				const cleanSourcePath = path.normalize(sourcePath);
				const cleanMainScriptPath = path.normalize(mainScriptPath);
				
				server = cp.exec(`cd /d "${cleanSourcePath}" && ${denoCmd} run --allow-read --allow-env "${cleanMainScriptPath}" server`, {maxBuffer: Infinity})
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
	await client.onReady();
	client.onNotification("loaded",(param: {}) => {
		client.sendNotification("terracotta/updateConfiguration",{
			dfRank: getConfigValue("rank"),
			rankBehavior: getConfigValue("rankBehavior"),
		})
	})
}

async function buildToMinecraft(debugSession: vscode.DebugSession, launchArguments: any): Promise<void> {
	function bluelog(message: any) {
		console.log(message);
		debugSession.customRequest("bluelog",""+message);
	}
	function log(message: any) {
		console.log(message);
		debugSession.customRequest("log",""+message);
	}
	function error(message: any) {
		console.error(message);
		debugSession.customRequest("error",""+message);
	}
	function end(exitCode: number) {
		debugSession.customRequest("end",exitCode);
	}
	/** returns true if successful, false if otherwise */
	async function changeMode(mode: TCClient.DFMode): Promise<boolean> {
		let modeChangeResponse = await TCClient.sendRequestAsync(new TCClient.ChangeModeA2CRequest(mode));
		if (modeChangeResponse instanceof TCClient.ErrorResponse) {
			error(`Could not switch to ${mode.toLowerCase()} mode: ${modeChangeResponse.errorMessage}`)
			end(1); return false;
		}
		return true;
	}
	try {
		let terracottaInstallPath = useSourceCode ? sourcePath : terracottaPath;
		
		let rank: string = getConfigValue("rank") ?? "Unranked";
		if (rank === "") {
			rank = "Unranked"
		} else if (!rank.match(/^[a-zA-Z]+$/g)) {
			rank = "overlord"
		}
		
		let plotOverrides = launchArguments.plotOverrides?.[TCClient.plotId.toString()] ?? {};

		let plotSize = plotOverrides.plotSize?.toString() ?? launchArguments.plotSize.toString()
		if (!plotSize.match(/^[0-9.]+$/g)) {
			plotSize = "300"
		}
		let autoSwitchToDev = plotOverrides.autoSwitchToDev ?? launchArguments.autoSwitchToDev;
		let autoSwitchToPlay = plotOverrides.autoSwitchToPlay ?? launchArguments.autoSwitchToPlay;

		let folderUrl = launchArguments.folder;
		let tcMetaFolderPath = path.join(folderUrl,".terracotta");
		let hashFilePath = path.join(tcMetaFolderPath,"templateHash_"+TCClient.plotId);
		let newHashFilePath = path.join(tcMetaFolderPath,"newTemplateHash_"+TCClient.plotId);

		//create .terracotta folder if it doesnt already exist
		try {
			await fs.stat(tcMetaFolderPath)
		} catch (e: any) {
			if (e.code == "ENOENT") {
				await fs.mkdir(tcMetaFolderPath)
			} else {
				error(`Could not access .terracotta folder (error code:${e.errno})`);
				end(1); return;
			}
		}

		// compile the project and get resulting templates
		let templates: Dict<any>
		try {
			let command: string 
			if (useSourceCode) {
				if (process.platform == "darwin") {
					command = `cd "${terracottaInstallPath}"; ~/.deno/bin/deno run --allow-read --allow-env "${terracottaInstallPath}src/main.ts"`
				}
				else if (process.platform == "win32") {
					command = `cd "${terracottaInstallPath}/src" && deno run --allow-read --allow-env main.ts`
				}
				else {
					// Who cares abt linux?
				}
			} else {
				if (process.platform == "win32") {
					command = `"${terracottaInstallPath.replaceAll('"','\\"')}"`
				} else {
					command = `"${terracottaInstallPath.replaceAll("\\","\\\\").replaceAll('"','\\"')}"`
				}
			}
			command += ` compile --project "${launchArguments.folder}" --includemeta --plotsize ${plotSize} --rank ${rank}`
			bluelog("Compiling using command:\n"+command+"\n");
			templates = JSON.parse(cp.execSync(command,{cwd: os.homedir()}).toString())
		}
		catch (e: any) {
			// has to be split into chunks since for some reason
			// the debugger just refuses to print streams that are too long
			// unless they're heavily chunked like this
			let errors = e.output[2].toString() as string;
			const lines = errors.split("\n");
			const chunks = [];

			for (let i = 0; i < lines.length; i += 200) {
				chunks.push(lines.slice(i, i + 200).join("\n"));
			}

			for (const chunk of chunks) {
				error(chunk);
			}
			end(1); return;
		}

		//= figure out what templates should be changed =\\
		let seenTemplates: Dict<Set<string>> = {
			functions: new Set<string>(),
			processes: new Set<string>(),
			playerEvents: new Set<string>(),
			entityEvents: new Set<string>(),
			gameEvents: new Set<string>(),
		}

		let oldTemplatesHashes: Dict<Dict<string>> = {
			functions: {},
			processes: {},
			playerEvents: {},
			entityEvents: {},
			gameEvents: {},
		}
		
		//read hashes of the last compilation
		let fileContents: string | undefined = undefined
		try {
			fileContents = (await fs.readFile(hashFilePath)).toString()
		} catch (e) {
			console.error("failed to read template hash", e)
		}

		if (fileContents !== undefined) {
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
		let placeTemplates: string[] = []
		let breakTemplates: TCClient.TemplateIdentifier[] = [];
		let changedTemplateCount: number = 0

		;["functions","processes","playerEvents","entityEvents","gameEvents"].forEach(headerFileType => {
			const headerTemplateType: TCClient.TemplateType = 
				headerFileType == "functions" ? TCClient.TemplateType.FUNCTION : 
				headerFileType == "processes" ? TCClient.TemplateType.PROCESS : 
				headerFileType == "playerEvents" ? TCClient.TemplateType.PLAYER_EVENT :
				headerFileType == "entityEvents" ? TCClient.TemplateType.ENTITY_EVENT :
				TCClient.TemplateType.GAME_EVENT
			let hashes: Dict<string> = {}

			//get hashes of new templates
			newHashFileContents += ">"+headerFileType+"\n"
			for (const [name, template] of Object.entries(templates[headerFileType]) as [string,string][]) {
				let hash = crypto.createHash('md5').update(template).digest("hex")

				seenTemplates[headerFileType]!.add(name)
				hashes[name] = hash
				
				newHashFileContents += hash+" "+name+"\n"
			}

			//figure out what edits need to occur
			seenTemplates[headerFileType]!.forEach(templateName => {
				if (templateName === undefined) { return; }
				// if template needs to be broken
				if (!(templateName in hashes)) {
					breakTemplates.push({type: headerTemplateType, name: templateName})
					changedTemplateCount += 1;
				}
				//if template is new or has changed
				else if (
					!(templateName in oldTemplatesHashes[headerFileType]!) || 
					(hashes[templateName] != oldTemplatesHashes[headerFileType]![templateName])
				) {
					placeTemplates.push(templates[headerFileType][templateName]);
					changedTemplateCount += 1;
				}
			})
		})

		await fs.writeFile(newHashFilePath,newHashFileContents,"utf-8")

		//= actually send to the placer =\\

		if (changedTemplateCount == 0) {
			log(`No template changes detected since last compilation`);		
			await fs.rename(newHashFilePath,hashFilePath)
			end(0); return;
		}

		// make sure minecraft state is correct
		if (!TCClient.isConnected) {
			log(`Terracotta Client is not connected. If Minecraft is actually running, try 'Refresh Client Connection' from the Command Pallette.`)
			end(1); return;
		}
		if (!TCClient.isAuthed) {
			log("Terracotta is not authorized to make changes, please allow it in your Minecraft client.");
			end(1); return;
		}
		if (TCClient.mode == TCClient.DFMode.SPAWN) {
			log("Terracotta cannot build to a plot from spawn, please join a plot.");
			end(1); return;
		}
		if (TCClient.mode != TCClient.DFMode.DEV) {
			if (autoSwitchToDev) {
				log(`Switching to dev mode (currently in ${TCClient.mode.toLowerCase()})`);
				if (!await changeMode(TCClient.DFMode.DEV)) return;
			} else {
				log(`You are currently in ${TCClient.mode} mode. Please switch to dev or add '"autoSwitchToDev": true' to your launch configuration.`);
				end(1); return;
			}
		}
		let plotIds: number[] = launchArguments.plotIds ?? [];
		if (plotIds.length > 0 && !plotIds.includes(TCClient.plotId)) {
			log(`Compilation was canceled because plot '${TCClient.plotName}' (id: ${TCClient.plotId}) is not included in the list of allowed plots.\n\nTo compile to this plot, add ${TCClient.plotId} to the 'plotIds' array in your launch.json configuration.`);
			end(1); return;
		}

		(debugSession.configuration as any).isEditingCode = true;
		if (TCClient.scanState != TCClient.ScanState.SCANNED) {
			log(`Scanning codespace... (this may take a few seconds)`);
			let response = await TCClient.sendRequestAsync(new TCClient.RescanPlotA2CRequest());
			if (response instanceof TCClient.ErrorResponse) {
				error(`Failed to scan plot: ${response.errorMessage}`);
				end(1); return;
			}
		}

		log("Starting to place code...");
		let placeResponse = await TCClient.sendRequestAsync(new TCClient.InitiateCodeEditA2CRequest(placeTemplates,breakTemplates));
		(debugSession.configuration as any).isEditingCode = false;
		if (placeResponse instanceof TCClient.ErrorResponse) {
			error(`Failed to place code: ${placeResponse.errorMessage}`);
			end(1); return;
		}

		await fs.rename(newHashFilePath,hashFilePath)

		log(`Code placing complete! ${autoSwitchToPlay ? "Automatically switching to play mode" : ""}\n`);
		if (autoSwitchToPlay) {
			if (!await changeMode(TCClient.DFMode.PLAY)) return;
		}
		end(0); return;
	} catch (e) {
		error(`####\nInternal extension error while attempting to send code to Minecraft! (Report the below text to a Terracotta developer)\n###\n\n${e}\n${e instanceof Error ? e.stack : ""}`);
		end(1); return;
	}
}

//==========[ extension events ]=========\

export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel("Terracotta LSP")
	outputChannel.show()

	vscode.commands.executeCommand('setContext', 'terracotta.extensionActivated', true);

	versionManager = new VersionManager(context,async () => {
		updateVersionStatusBar()
		// automatically download latest version when first installing
		if (getConfigValue("version") == "") {
			if (!versionManager.installedVersions.has(versionManager.latestDownloadableRelease)) {
				await downloadAndChangeVersion(versionManager.latestDownloadableRelease)
			} else {
				vscode.workspace.getConfiguration("terracotta").update("version",versionManager.latestDownloadableRelease,vscode.ConfigurationTarget.Global)
			}
		}
		// reminder if ur on an outdated version
		else {
			if (versionManager.isUpdateAvailable(getConfigValue("version")!)) {
				vscode.window.showInformationMessage(
					`A newer version of Terracotta is available: v${versionManager.latestDownloadableRelease}`,
					"Update",
					"Dismiss",
				).then(option => {
					if (option == "Update") {
						downloadAndChangeVersion(versionManager.latestDownloadableRelease)
					}
				})
			}
		}
	})

	const downloadStatusBarItem = vscode.window.createStatusBarItem("terracottaDownload",vscode.StatusBarAlignment.Left,-301)

	async function downloadAndChangeVersion(version: string) {
		downloadStatusBarItem.text = `$(loading~spin) Donwloading Terracotta v${version}`
		downloadStatusBarItem.show()
		vscode.window.showInformationMessage(`Downloading Terracotta v${version}`)
		try {
			await versionManager.downloadVersion(version)
		} catch (e) {
			vscode.window.showErrorMessage(`${e}`,{modal: true})
			downloadStatusBarItem.hide()
			return
		}
		downloadStatusBarItem.hide()
		vscode.window.showInformationMessage(`Successfully downloaded and switched to Terracotta v${version}`)
		if (getConfigValue("version") == version) {
			startLanguageServer()
		} else {
			vscode.workspace.getConfiguration("terracotta").update("version",version,vscode.ConfigurationTarget.Global)
		}
	}
	
	updateTerracottaPath()
	startItemLibraryEditor(context)

	//= terracotta client stuff =\\
	TCClient.initialize(context)
	TCClient.tryConnection();

	TCClient.setAutoConnect(getConfigValue("autoConnectToTerracottaClient"))

	//= status bar and disconnect handling =\\

	const versionStatusBarItem = vscode.window.createStatusBarItem("terracottaVersion",vscode.StatusBarAlignment.Right,-300)
	versionStatusBarItem.name = "Terracotta Version"
	versionStatusBarItem.command = "extension.terracotta.changeVersion"
	versionStatusBarItem.show()
	function updateVersionStatusBar() {
		let currentVersion = getConfigValue("version") as string
		let updateText = versionManager.isUpdateAvailable(currentVersion) ? " (update available)" : ""
		versionStatusBarItem.text = `Terracotta v${currentVersion}${updateText}`
	}
	updateVersionStatusBar()

	const tcClientStatusBarItem = vscode.window.createStatusBarItem("tcClientConnection",vscode.StatusBarAlignment.Right,-299)
	TCClient.onConnectionStatusChanged((isConnected, isAuthed) => {
		if (isConnected) {
			tcClientStatusBarItem.show();
		} else {
			tcClientStatusBarItem.hide();
			return;
		}
		if (isAuthed) {
			tcClientStatusBarItem.text = "$(check)Connected to MC"
			tcClientStatusBarItem.backgroundColor = undefined
			tcClientStatusBarItem.command = undefined
		} else {
			tcClientStatusBarItem.text = "$(close)Awaiting permission in MC"
			tcClientStatusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground")
			tcClientStatusBarItem.command = "extension.terracotta.info.tcClientAuth"

			for (const key of Object.keys(itemsBeingEdited)) {
				delete itemsBeingEdited[key];
			}
			if (itemEditorProvider) itemEditorProvider.refresh();
		}
	});
	

	//= commands =\\
	vscode.commands.registerCommand("extension.terracotta.refreshAuthentication", () => {
		if (TCClient.isConnected) {
			vscode.window.showInformationMessage("Refreshing authentication, check your Minecraft Client");
			TCClient.refreshToken();
		} else {
			vscode.window.showErrorMessage("Authentication cannot be refreshed unless Terracotta is connected to Minecraft");
			TCClient.tryConnection();
		}
	});

	vscode.commands.registerCommand("extension.terracotta.refreshConnection",() => {
		TCClient.tryConnection();
	})

	vscode.commands.registerCommand("extension.terracotta.test",async () => {
		// TCClient.sendRequest(
		// 	new TCClient.InitiateCodeEditA2CRequest(
		// 		// [],
		// 		['H4sIAAAAAAAA/6WSMWvDMBCF/4q4OUMpbQdtoVMHL03oUkq4WIciKktGOpWE4P/ek21al5IhZJL07t29T0hn2PvYfmbQ72dwBvR0htW8aqAvCixnTFZcYmLqqv1jEK1lF4OYng/IMKwujOg9nijtZvf/UdNuVGo7H2ueQcYqBexIRONKsCXDILHZRwZ9N+YtG/d+x2gXvbGf+bapkOi1quElHCg5Vhs+ecqwuMaGgmkoZ7R0Ef8X4P7hCoK1MSr32I6BE8eWjqze0BdSDSXrgr2B5fEKlleyxWP6AVl7Z0Mnz6yaaOgGiKfhz69YdkvlG+EEqSFsAgAA'],
		// 		[],
		// 		// [{"type": TCClient.TemplateType.PlayerEvent, "name": "Chat"}],
		// 	),
		// 	(request, response: TCClient.InitiateCodeEditC2AResponse) => {
		// 		if (response instanceof TCClient.ErrorResponse) {
		// 			vscode.window.showErrorMessage("Error placing templates: "+response.errorMessage);
		// 		} else {
		// 			vscode.window.showInformationMessage("placement successful!");
		// 		}
		// 	}
		// )
	})

	vscode.commands.registerCommand("extension.terracotta.info.tcClientAuth",() => {
		vscode.window.showInformationMessage("Terracotta is not authorized to interact with Minecraft. Please give it access from within your Minecraft client to enable full functionality.",{modal: true})
	})

	vscode.commands.registerCommand("extension.terracotta.importCodeValue",async () => {
		if (!client) {
			vscode.window.showErrorMessage("Cannot import code values because the language server is not running.","Restart language server")
			.then(value => {
				if (value == "Restart language server") {
					startLanguageServer();
				}
			});
			return;
		}

		let valuesResponse: TCClient.GetCodeValuesA2CResponse = await TCClient.sendRequestAsync(new TCClient.GetCodeValuesA2CRequest());
		if (handleErrorResponse(valuesResponse, "import code values")) return;

		let conversionResult = await client.sendRequest<{values: {dfType: string, value: string}[]}>("terracotta/convertValues", Object.values(valuesResponse.values));

		let qp = vscode.window.createQuickPick();
		qp.title = "Import Code Values from Inventory";
		qp.placeholder = "Click a value to copy it to the clipboard. Type here to search.";
		qp.ignoreFocusOut = true;
		qp.canSelectMany = false;
		qp.onDidAccept(() => {
			npc.copy((qp.activeItems[0] as any).value);
			qp.dispose();
		});
		qp.items = conversionResult.values.map(r => ({
			label: `$(dfcodeitem-${r.dfType}) ${r.value}`,
			value: r.value,
		}));
		qp.show();
	})

	vscode.commands.registerCommand("extension.terracotta.changeVersion",() => {
		//key is the additional info that will be displayed next to the version
		let versionsToDisplay: {[key: string]: string} = {}
		for (const version of versionManager.downloadableVersions) {
			versionsToDisplay[version] = ""
			if (version == versionManager.latestDownloadableRelease) {
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
						downloadAndChangeVersion(version)
					}
				})
			} else {
				vscode.workspace.getConfiguration("terracotta").update("version",version,vscode.ConfigurationTarget.Global)
				vscode.window.showInformationMessage(`Switched to Terracotta v${version}`)
			}
		})
	})

	vscode.commands.registerCommand("extension.terracotta.restartLanguageServer", () => {
		startLanguageServer();
	})

	//= set up debugger =\\

	vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
		if (event.event == "log") {
			console.log(event.body)
		}
		else if (event.event == "sendLaunchArgs") {
			let launchArgs = event.body;
			if (
				launchArgs.exportMode == "sendToCodeClient" // support legacy codeclient launch configs
				|| launchArgs.exportMode == "sendToMinecraft"
			) {
				buildToMinecraft(event.session, launchArgs);
			}
		}
	})

	vscode.debug.onDidStartDebugSession(async session => {
		debuggers[session.id] = session;
	})

	vscode.debug.onDidTerminateDebugSession(session => {
		if ((session.configuration as any).isEditingCode) {
			TCClient.sendRequest(new TCClient.AbortCodeEditA2CRequest());
		}
		delete debuggers[session.id];
	})

	//= settings response =\\
	vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration("terracotta.version") || event.affectsConfiguration("terracotta.installPath") || event.affectsConfiguration("terracotta.useSourceCode") || (useSourceCode && event.affectsConfiguration("terracotta.sourcePath"))) {
			updateVersionStatusBar()
			updateTerracottaPath()
			startLanguageServer()
		}
		else if (event.affectsConfiguration("terracotta.autoConnectToTerracottaClient")) {
			TCClient.setAutoConnect(getConfigValue("autoConnectToTerracottaClient"))
		}
		if (client) {
			if (event.affectsConfiguration("terracotta.rank")) {
				client.sendNotification("terracotta/updateConfiguration",{dfRank: getConfigValue("rank")})
			}
			else if (event.affectsConfiguration("terracotta.rankBehavior")) {
				client.sendNotification("terracotta/updateConfiguration",{rankBehavior: getConfigValue("rankBehavior")})
			}
		}
	})

	//= set up language server =\\
	if (getConfigValue("version") != "") {
		startLanguageServer()
	}
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined
	}
	client.sendNotification("terracotta/exit");
	vscode.commands.executeCommand('setContext', 'terracotta.extensionActivated', false);
	console.log("DEACTIVATE")
	return client.stop()
}