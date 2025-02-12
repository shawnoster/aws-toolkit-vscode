/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as nls from 'vscode-nls'
const localize = nls.loadMessageBundle()

import * as vscode from 'vscode'
import { AwsContext } from '../shared/awsContext'
import * as localizedText from '../shared/localizedText'
import { createQuickPick, promptUser } from '../shared/ui/picker'
import { AwsExplorer } from './awsExplorer'
import { getIdeProperties } from '../shared/extensionUtilities'
import { PromptSettings } from '../shared/settings'

class RegionMissingUI {
    public static readonly add: string = localizedText.yes
    public static readonly alwaysIgnore: string = localize(
        'AWS.message.prompt.noDontAskAgain',
        "No, and don't ask again"
    )
    public static readonly ignore: string = localizedText.no
}

export async function checkExplorerForDefaultRegion(
    profileName: string,
    awsContext: AwsContext,
    awsExplorer: AwsExplorer
): Promise<void> {
    const profileRegion = awsContext.getCredentialDefaultRegion()

    const explorerRegions = new Set(await awsContext.getExplorerRegions())
    if (explorerRegions.has(profileRegion)) {
        return
    }

    const shouldPrompt = await PromptSettings.instance.isPromptEnabled('regionAddAutomatically')
    if (!shouldPrompt) {
        return
    }

    // Prompt: "Add region?"
    // Choices: "Yes", "No", "No, don't ask again"
    const items = [RegionMissingUI.add, RegionMissingUI.ignore, RegionMissingUI.alwaysIgnore].map<vscode.QuickPickItem>(
        item => {
            return {
                label: item,
            }
        }
    )

    const picker = createQuickPick({
        options: {
            canPickMany: false,
            ignoreFocusOut: true,
            title: localize(
                'AWS.message.prompt.defaultRegionHidden',
                'Show the default region "{0}" for credentials "{1}" in {2} Explorer?',
                profileRegion,
                profileName,
                getIdeProperties().company
            ),
        },
        items: items,
    })
    const r = await promptUser({ picker: picker })

    // User Cancelled
    if (!r || r.length === 0) {
        return
    }

    const response = r[0].label

    if (response === RegionMissingUI.add) {
        await awsContext.addExplorerRegion(profileRegion)
        awsExplorer.refresh()
    } else if (response === RegionMissingUI.alwaysIgnore) {
        PromptSettings.instance.disablePrompt('regionAddAutomatically')
    }
}
