/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'path'
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as mime from 'mime-types'
import { mkdirp } from 'fs-extra'
import { OutputChannel } from 'vscode'
import { ext } from '../../shared/extensionGlobals'
import { makeTemporaryToolkitFolder } from '../../shared/filesystemUtilities'
import { showOutputMessage } from '../../shared/utilities/messages'
import { Commands } from '../../shared/vscode/commands'
import { downloadWithProgress } from '../commands/downloadFileAs'
import { S3FileNode } from '../explorer/s3FileNode'
import { readablePath } from '../util'
import { getLogger } from '../../shared/logger'
import { showConfirmationMessage } from '../../shared/utilities/messages'
import { localize } from '../../shared/utilities/vsCodeUtils'
import { uploadWithProgress } from '../commands/uploadFile'

const SIZE_LIMIT = 4 * Math.pow(10, 6)
export interface S3Tab {
    fileUri: vscode.Uri
    s3Uri: vscode.Uri
    editor: vscode.TextEditor | undefined
    s3FileNode: S3FileNode
}

export class S3FileViewerManager {
    private outputChannel: OutputChannel
    private promptOnEdit = true
    //onDidChange to trigger refresh of contents on the document provider
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>()
    public get onDidChange(): vscode.Event<vscode.Uri> {
        return this._onDidChange.event
    }

    //this field stores the next file to be opened in preview mode
    //reason for this is to avoid a race condition when downloading bigger files (within limit of preview)
    //and a smaller file, the one needed to be displayed is the last one clicked
    private toPreview: string | undefined

    public constructor(
        private cacheArns: Set<string> = new Set<string>(),
        private window: typeof vscode.window = vscode.window,
        private commands = Commands.vscode(),
        private _tempLocation?: string,
        private activeTabs: Map<string, S3Tab> = new Map<string, S3Tab>()
    ) {
        this.outputChannel = ext.outputChannel
        let ongoingUpload = false
        vscode.workspace.onDidSaveTextDocument(async savedTextDoc => {
            if (ongoingUpload) {
                return
            }
            ongoingUpload = true
            if (this.activeTabs.has(savedTextDoc.uri.fsPath)) {
                const activeTab = this.activeTabs.get(savedTextDoc.uri.fsPath)!
                let upload = true

                if (!(await this.isValidFile(activeTab.s3FileNode, activeTab.fileUri))) {
                    const cancelUpload = localize('AWS.s3.fileViewer.button.cancelUpload', 'Cancel download')
                    const overwrite = localize('AWS.s3.fileViewer.button.overwrite', 'Overwrite')

                    const response = await window.showErrorMessage(
                        localize(
                            'AWS.s3.fileViewer.error.invalidUpload',
                            'File has changed in S3 since last cache download. Compare your version with the one in S3, then choose to overwrite it or cancel this upload.'
                        ),
                        cancelUpload,
                        overwrite
                    )
                    if (response === cancelUpload) {
                        //TODO: uncomment when https://github.com/aws/aws-toolkit-common/pull/188 merges
                        //telemetry.recordS3UploadObject({result: 'Cancelled', kind: viewer})
                        upload = false
                    }
                }

                if (upload) {
                    if (!(await this.uploadChangesToS3(activeTab))) {
                        //TODO: uncomment when https://github.com/aws/aws-toolkit-common/pull/188 merges
                        //telemetry.recordS3UploadObject({result: 'Failed', kind: viewer})
                        this.window.showErrorMessage('Error uploading file to S3.')
                        return
                    }
                    //TODO: uncomment when https://github.com/aws/aws-toolkit-common/pull/188 merges
                    //telemetry.recordS3UploadObject({result: 'Success', kind: viewer})
                }

                const fileNode = await this.refreshNode(activeTab.s3FileNode)

                await this.focusAndCloseTab(activeTab.fileUri, activeTab.editor)
                activeTab.editor = undefined
                await this.openInReadMode(fileNode)
                this._onDidChange.fire(activeTab.s3Uri)

                if (upload) {
                    if (!(await this.uploadChangesToS3(activeTab))) {
                        this.window.showErrorMessage(
                            'Error uploading file to S3. Changes were not saved back to S3. Please try and resave this edit mode file'
                        )
                    }
                }

                ongoingUpload = false
            }
        })
    }

    public async focusAndCloseTab(
        uri: vscode.Uri,
        editor?: vscode.TextEditor,
        workspace = vscode.workspace
    ): Promise<void> {
        const doc = editor ? editor.document : await workspace.openTextDocument(uri)
        await this.window.showTextDocument(doc, {
            preview: false,
            viewColumn: editor?.viewColumn,
        })
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
    }

    /**
     * Given an S3FileNode, this function:
     * Checks and creates a cache to store downloads
     * Retrieves previously cached files on cache and
     * Downloads file from S3 ands stores in cache
     * Opens the tab on read-only with the use of an S3Tab, or shifts focus to an edit tab if any.
     *
     * @param fileNode
     */
    public async openInReadMode(fileNode: S3FileNode): Promise<void> {
        if (fileNode.file.sizeBytes! < SIZE_LIMIT) {
            this.toPreview = fileNode.file.arn
        }

        getLogger().verbose(`S3FileViewer: Retrieving and displaying file: ${fileNode.file.key}`)
        showOutputMessage(
            localize('AWS.s3.fileViewer.info.fileKey', 'Retrieving and displaying file: {0}', fileNode.file.key),
            this.outputChannel
        )

        const charset = await fileNode.s3.getCharset({ key: fileNode.file.key, bucketName: fileNode.bucket.name })

        const fileLocation = await this.getFile(fileNode)
        if (!fileLocation) {
            //TODO: uncomment when https://github.com/aws/aws-toolkit-common/pull/188 merges
            //telemetry.recordS3EditObject({ result: 'Failed' })
            return
        }
        getLogger().verbose(`S3FileViewer: File from s3 or temp to be opened is: ${fileLocation}`)
        const s3Uri = vscode.Uri.parse('s3:' + fileLocation.fsPath)

        if (charset != 'UTF-8') {
            const prompt = "Can't open this file type in read-only mode, do you want to try opening in edit?"
            const edit = 'Open in edit mode'
            const read = 'Try in read-only'
            if (await showConfirmationMessage({ prompt, confirm: edit, cancel: read }, this.window)) {
                await this.openInEditMode(fileNode)
                return
            }
        }

        let tab: S3Tab | undefined
        if (fileNode.file.sizeBytes! < SIZE_LIMIT) {
            const pathToPreview = await this.arnToFsPath(this.toPreview!)
            if (s3Uri.fsPath !== pathToPreview) {
                return
            }
            tab =
                this.activeTabs.get(pathToPreview) ??
                ({ fileUri: fileLocation, s3Uri, editor: undefined, s3FileNode: fileNode } as S3Tab)

            await this.openTextFile(tab, tab.s3Uri, true)
            this.toPreview = undefined
        } else {
            tab =
                this.activeTabs.get(fileLocation.fsPath) ??
                ({ fileUri: fileLocation, s3Uri, editor: undefined, s3FileNode: fileNode } as S3Tab)
            await this.openTextFile(tab, tab.s3Uri, false)
        }

        this.activeTabs.set(fileLocation.fsPath, tab)
    }

    /**
     * Given an S3FileNode or an URI, this function:
     * Checks and creates a cache to store downloads
     * Retrieves previously cached files on cache and
     * Downloads file from S3 ands stores in cache
     * Opens the tab on read-only with the use of an S3Tab, or shifts focus to an edit tab if any.
     *
     * @param uriOrNode to be opened
     */
    public async openInEditMode(uriOrNode: vscode.Uri | S3FileNode): Promise<void> {
        if (this.promptOnEdit) {
            const message = localize(
                'AWS.s3.fileViewer.warning.editStateWarning',
                'You are now editing an S3 file. Saved changes will be uploaded to your S3 bucket.'
            )

            const dontShow = localize('AWS.s3.fileViewer.button.dismiss', "Don't show this again")
            const help = localize('AWS.generic.message.learnMore', 'Learn more')

            this.window.showWarningMessage(message, dontShow, help).then(selection => {
                if (selection === dontShow) {
                    this.promptOnEdit = false
                }

                if (selection === help) {
                    //TODO: add help section
                }
            })
        }
        if (uriOrNode instanceof vscode.Uri) {
            //was activated from an open tab
            if (this.activeTabs.has(uriOrNode.fsPath)) {
                const tab = this.activeTabs.get(uriOrNode.fsPath)

                const contentType = mime.contentType(path.extname(tab!.fileUri.fsPath))

                if (contentType) {
                    if (mime.charset(contentType) != 'UTF-8') {
                        this.focusAndCloseTab(tab!.s3Uri, tab!.editor)
                        tab!.editor = await vscode.commands.executeCommand('vscode.open', tab!.fileUri, {
                            preview: false,
                        })
                        //TODO: uncomment when https://github.com/aws/aws-toolkit-common/pull/188 merges
                        //telemetry.recordS3EditObject({ result: 'Success' })
                        return
                    }
                }

                await this.openTextFile(tab!, tab!.fileUri, false)

                this.activeTabs.set(uriOrNode.fsPath, tab!)
            } else {
                this.window.showErrorMessage(
                    localize(
                        'AWS.s3.fileViewer.error.editMode',
                        'Error switching to edit mode, please try reopening from the AWS Explorer'
                    )
                )
            }
        } else {
            //was activated from the explorer, need to get the file
            const fileNode = uriOrNode
            const charset = await fileNode.s3.getCharset({ key: fileNode.file.key, bucketName: fileNode.bucket.name })

            const fileLocation = await this.getFile(uriOrNode)
            if (!fileLocation) {
                //TODO: uncomment when https://github.com/aws/aws-toolkit-common/pull/188 merges
                //telemetry.recordS3EditObject({ result: 'Failed' })
                return
            }
            const s3Uri = vscode.Uri.parse(fileLocation.fsPath)
            let tab = this.activeTabs.get(fileLocation.fsPath)

            if (!tab) {
                tab = { fileUri: fileLocation, s3Uri, editor: undefined, s3FileNode: uriOrNode } as S3Tab
            }

            //If not UTF-8 (text file), differ to vscode's open functionality
            if (charset != 'UTF-8') {
                tab.editor = await vscode.commands.executeCommand('vscode.open', tab.fileUri, { preview: false })
            } else {
                tab.editor = await this.openTextFile(tab, tab.fileUri, false)
            }

            this.activeTabs.set(tab.fileUri.fsPath, tab)
        }
    }

    /**
     * Opens a given file on given tab and specified mode (read-only or edit mode)
     *
     * @param tab
     * @param uri Uri to be opened will use the scheme attached to this
     * @param preview boolean for argument to window.showTextDocument()
     * @param workspace
     * @returns
     */
    public async openTextFile(
        tab: S3Tab,
        uri: vscode.Uri,
        preview: boolean,
        workspace = vscode.workspace
    ): Promise<vscode.TextEditor | undefined> {
        const openEditor = tab.editor

        try {
            let doc = await workspace.openTextDocument(uri)
            if (!openEditor) {
                //there wasn't any open, just display it regularly
                tab.editor = await this.window.showTextDocument(doc, { preview, viewColumn: 0 })
                return tab.editor
            } else if (openEditor.document.uri.scheme === 'file' || openEditor.document.uri.scheme === uri.scheme) {
                doc = openEditor.document
                //there is a tab for this uri scheme open (or scheme file <<priority>>), just shift focus to it by reopening it with the ViewColumn option
                tab.editor = await this.window.showTextDocument(doc, {
                    preview: false,
                    viewColumn: openEditor.viewColumn,
                })
                return tab.editor
            } else {
                // there is already a tab open, it needs to be focused, then closed
                await this.focusAndCloseTab(tab.fileUri, tab.editor)
                //good to open in given mode
                tab.editor = await this.window.showTextDocument(doc, { preview })
                return tab.editor
            }
        } catch (e) {
            //TODO: uncomment when https://github.com/aws/aws-toolkit-common/pull/188 merges
            //telemetry.recordS3EditObject({ result: 'Failed' })
            this.window.showErrorMessage(`Error opening file ${e}`)
            tab.editor = undefined
            return tab.editor
        }
        //TODO: uncomment when https://github.com/aws/aws-toolkit-common/pull/188 merges
        //telemetry.recordS3EditObject({ result: 'Success' })
    }

    /**
     * Fetches a file from S3 or gets it from the local cache if possible and still valid (this.checkForValidity()).
     *
     * @see S3FileViewerManager.isValidFile()
     */
    public async getFile(fileNode: S3FileNode): Promise<vscode.Uri | undefined> {
        if (!this._tempLocation) {
            await this.createTemp()
        }
        const targetPath = await this.createTargetPath(fileNode)
        const targetLocation = vscode.Uri.file(targetPath)

        const tempFile: vscode.Uri | undefined = await this.getFromTemp(fileNode)
        //If it was found in temp, return the Uri location
        if (tempFile) {
            return tempFile
        }

        if (fileNode.file.sizeBytes === undefined) {
            getLogger().debug(`FileViewer: File size couldn't be determined, prompting user file: ${fileNode}`)

            const message = localize(
                'AWS.s3.fileViewer.warning.noSize',
                "File size couldn't be determined. Continue with download?"
            )
            const args = {
                prompt: message,
                confirm: localize('AWS.generic.continueDownload', 'Continue with download'),
                cancel: localize('AWS.generic.cancel', 'Cancel'),
            }

            if (!(await showConfirmationMessage(args, this.window))) {
                getLogger().debug(`FileViewer: User cancelled download`)
                showOutputMessage(
                    localize('AWS.s3.fileViewer.message.noSizeCancellation', 'Download cancelled'),
                    this.outputChannel
                )
                return undefined
            }
        } else if (fileNode.file.sizeBytes > SIZE_LIMIT) {
            getLogger().debug(`FileViewer: File size ${fileNode.file.sizeBytes} is >4MB, prompting user`)

            const message = localize(
                'AWS.s3.fileViewer.warning.4mb',
                'File size is more than 4MB. Continue with download?'
            )
            const args = {
                prompt: message,
                confirm: localize('AWS.generic.continueDownload', 'Continue with download'),
                cancel: localize('AWS.generic.cancel', 'Cancel'),
            }

            if (!(await showConfirmationMessage(args, this.window))) {
                getLogger().debug(`FileViewer: User cancelled download`)
                showOutputMessage(
                    localize('AWS.s3.fileViewer.message.sizeLimitCancellation', 'Download cancelled'),
                    this.outputChannel
                )
                //TODO: uncomment when https://github.com/aws/aws-toolkit-common/pull/188 merges
                //telemetry.recordS3DownloadObject({ result: 'Cancelled', kind: 'Viewer' })
                return undefined
            }

            getLogger().debug(`FileViewer: User confirmed download, continuing`)
        }

        if (!(await this.createSubFolders(targetPath))) {
            //error creating the folder structure
            return undefined
        }

        try {
            await downloadWithProgress(fileNode, targetLocation, this.window)
            //TODO: uncomment when https://github.com/aws/aws-toolkit-common/pull/188 merges
            //telemetry.recordS3DownloadObject({ result: 'Success', kind: 'Viewer' })
        } catch (err) {
            //TODO: uncomment when https://github.com/aws/aws-toolkit-common/pull/188 merges
            //telemetry.recordS3DownloadObject({ result: 'Cancelled', kind: 'Viewer' })
            getLogger().error(`FileViewer: error calling downloadWithProgress: ${err.toString()}`)
            showOutputMessage(
                localize(
                    'AWS.s3.fileViewer.error.download',
                    'Error downloading file {0} from S3: {1}',
                    fileNode.file.name,
                    err.toString()
                ),
                this.outputChannel
            )
            return undefined
        }

        this.cacheArns.add(fileNode.file.arn)
        getLogger().debug(`New cached file: ${fileNode.file.arn} \n Cache contains: ${this.cacheArns.toString()}`)
        return targetLocation
    }

    /**
     * Searches for given node previously downloaded to cache.
     * Ensures that the cached download is still valid (hasn't been modified in S3 since its caching)
     *
     * @param fileNode - Node to be searched in temp
     * @returns Location in temp directory, if any
     */
    public async getFromTemp(fileNode: S3FileNode): Promise<vscode.Uri | undefined> {
        const targetPath = await this.createTargetPath(fileNode)
        const targetLocation = vscode.Uri.file(targetPath)

        if (this.cacheArns.has(fileNode.file.arn)) {
            getLogger().info(
                `FileViewer: found file ${fileNode.file.key} in cache\n Cache contains: ${this.cacheArns.toString()}`
            )

            if (await this.isValidFile(fileNode, targetLocation)) {
                getLogger().info(`FileViewer: good to retrieve, last modified date is before creation`)
                return targetLocation
            } else {
                fs.unlinkSync(targetPath)
                getLogger().info(
                    `FileViewer: Last modified in s3 date is after cached date, removing file and redownloading`
                )
                return undefined
            }
        }
        return undefined
    }

    /**
     * E.g. For a file 'foo.txt' inside a bucket 'bucketName' and folder 'folderName'
     * '/tmp/aws-toolkit-vscode/vsctkzV38Hc/bucketName/folderName/[S3]foo.txt'
     *
     * @param fileNode
     * @returns fs path that has the tempLocation, the S3 location (bucket and folders) and the name with the file preceded by [S3]
     */
    public createTargetPath(fileNode: S3FileNode): Promise<string> {
        let completePath = readablePath(fileNode)
        completePath = `${this.tempLocation!}${completePath.slice(4, completePath.lastIndexOf('/') + 1)}[S3]${
            fileNode.file.name
        }`

        return Promise.resolve(completePath)
    }

    private async createSubFolders(targetPath: string): Promise<boolean> {
        const folderStructure = targetPath.slice(undefined, targetPath.lastIndexOf('/'))

        try {
            await mkdirp(folderStructure)
        } catch (e) {
            getLogger().error(`S3FileViewer: Error creating S3 folder structure on system error: ${e}`)
            return false
        }
        return true
    }

    /**
     * Gets the latest instance of given fileNode
     *
     * @param fileNode
     * @returns
     */
    async refreshNode(fileNode: S3FileNode): Promise<S3FileNode> {
        const parent = fileNode.parent
        parent.clearChildren()

        await this.commands.execute('aws.refreshAwsExplorerNode', parent)
        await this.commands.execute('aws.loadMoreChildren', parent)

        const children = await parent.getChildren()

        children.forEach(child => {
            if ((child as any).name === fileNode.name) fileNode = child as S3FileNode
        })

        return fileNode
    }

    public async createTemp(): Promise<string> {
        this.tempLocation = await makeTemporaryToolkitFolder()
        showOutputMessage(
            localize(
                'AWS.s3.message.tempCreation',
                'Temp folder for FileViewer created with location: {0}',
                this.tempLocation
            ),
            this.outputChannel
        )
        getLogger().info(`S3FileViewer: Temp folder for FileViewer created with location: ${this._tempLocation}`)
        return this._tempLocation!
    }

    public get tempLocation(): string | undefined {
        return this._tempLocation
    }

    public set tempLocation(temp: string | undefined) {
        this._tempLocation = temp
    }

    /**
     * Checks that the cached date is after the last modified date in S3.
     * If not, file targetUri is invalid and needs to be redownloaded.
     *
     * @param fileNode instance in S3
     * @param targetUri file downloaded in system
     * @returns
     */
    private async isValidFile(fileNode: S3FileNode, targetUri: vscode.Uri): Promise<boolean> {
        const newNode = await this.refreshNode(fileNode)
        if (!newNode) {
            getLogger().error(`FileViewer: Error, refreshNode() returned undefined with file: ${fileNode.file.key}`)
            getLogger().debug(`Cache contains: ${this.cacheArns.toString()}`)
            return false
        }

        const lastModifiedInS3 = newNode.file.lastModified
        const { birthtime } = fs.statSync(targetUri.fsPath)

        getLogger().debug(
            `FileViewer: File ${newNode.file.name} was last modified in S3: ${lastModifiedInS3}, cached on: ${birthtime}`
        )

        if (!lastModifiedInS3) {
            getLogger().error(`S3FileViewer: FileNode has not last modified date, file node: ${fileNode.toString()}`)
            return false
        }

        return lastModifiedInS3 <= birthtime
    }

    /**
     * Uploads current uri back to parent
     *
     * @returns true if upload succeeded
     */
    public async uploadChangesToS3(tab: S3Tab): Promise<boolean> {
        const request = {
            bucketName: tab.s3FileNode.bucket.name,
            key: tab.s3FileNode.parent.path + tab.s3FileNode.name,
            fileLocation: tab.fileUri,
            fileSizeBytes: tab.s3FileNode.file.sizeBytes!,
            s3Client: tab.s3FileNode.s3,
            window: this.window,
        }
        try {
            await uploadWithProgress(request)
        } catch (e) {
            getLogger().error(e.message)
            return false
        }
        return true
    }

    public arnToFsPath(arn: string): Promise<string> {
        const s3Path = arn.split(':::')[1]
        const indexOfFileName = s3Path.lastIndexOf('/')
        const fileName = s3Path.slice(indexOfFileName + 1)
        const fsPath = `${this.tempLocation!}/${s3Path.slice(undefined, s3Path.lastIndexOf('/') + 1)}[S3]${fileName}`
        return Promise.resolve(fsPath)
    }
}
