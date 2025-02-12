/*!
 * Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert'
import * as sinon from 'sinon'
import * as vscode from 'vscode'

import { FakeExtensionContext } from '../../fakeExtensionContext'
import {
    handleTelemetryNoticeResponse,
    noticeResponseViewSettings,
    noticeResponseOk,
    TELEMETRY_NOTICE_VERSION_ACKNOWLEDGED,
    hasUserSeenTelemetryNotice,
    setHasUserSeenTelemetryNotice,
    TelemetryConfig,
    convertLegacy,
} from '../../../shared/telemetry/activation'
import { Settings } from '../../../shared/settings'

describe('handleTelemetryNoticeResponse', function () {
    let extensionContext: vscode.ExtensionContext
    let sandbox: sinon.SinonSandbox

    before(function () {
        sandbox = sinon.createSandbox()
    })

    after(function () {
        sandbox.restore()
    })

    beforeEach(async function () {
        extensionContext = await FakeExtensionContext.create()
    })

    it('does nothing when notice is discarded', async function () {
        await handleTelemetryNoticeResponse(undefined, extensionContext)

        assert.strictEqual(
            extensionContext.globalState.get(TELEMETRY_NOTICE_VERSION_ACKNOWLEDGED),
            undefined,
            'Expected opt out shown state to remain unchanged'
        )
    })

    it('handles View Settings response', async function () {
        const executeCommand = sandbox.stub(vscode.commands, 'executeCommand')

        await handleTelemetryNoticeResponse(noticeResponseViewSettings, extensionContext)

        assert.ok(executeCommand.calledOnce, 'Expected to trigger View Settings')
        assert.strictEqual(
            extensionContext.globalState.get(TELEMETRY_NOTICE_VERSION_ACKNOWLEDGED),
            2,
            'Expected opt out shown state to be set'
        )
    })

    it('handles Ok response', async function () {
        await handleTelemetryNoticeResponse(noticeResponseOk, extensionContext)

        assert.strictEqual(
            extensionContext.globalState.get(TELEMETRY_NOTICE_VERSION_ACKNOWLEDGED),
            2,
            'Expected opt out shown state to be set'
        )
    })
})

describe('Telemetry on activation', function () {
    const SETTING_KEY = 'aws.telemetry'

    const target = vscode.ConfigurationTarget.Workspace
    const settings = new Settings(target)

    let sut: TelemetryConfig

    beforeEach(function () {
        sut = new TelemetryConfig(settings)
    })

    afterEach(async function () {
        await sut.reset()
    })

    const scenarios = [
        {
            initialSettingValue: 'Enable',
            expectedIsEnabledValue: true,
            desc: 'Original opt-in value',
            expectedSanitizedValue: true,
        },
        {
            initialSettingValue: 'Disable',
            expectedIsEnabledValue: false,
            desc: 'Original opt-out value',
            expectedSanitizedValue: false,
        },
        {
            initialSettingValue: 'Use IDE settings',
            expectedIsEnabledValue: true,
            desc: 'Original deferral value',
            expectedSanitizedValue: 'Use IDE settings',
        },
        { initialSettingValue: true, expectedIsEnabledValue: true, desc: 'Opt in', expectedSanitizedValue: true },
        { initialSettingValue: false, expectedIsEnabledValue: false, desc: 'Opt out', expectedSanitizedValue: false },
        {
            initialSettingValue: 1234,
            expectedIsEnabledValue: true,
            desc: 'Unexpected numbers',
            expectedSanitizedValue: 1234,
        },
        {
            initialSettingValue: { label: 'garbageData' },
            expectedIsEnabledValue: true,
            desc: 'Unexpected object',
            expectedSanitizedValue: { label: 'garbageData' },
        },
        {
            initialSettingValue: [{ label: 'garbageDataList' }],
            expectedIsEnabledValue: true,
            desc: 'Unexpected array',
            expectedSanitizedValue: [{ label: 'garbageDataList' }],
        },
        {
            initialSettingValue: undefined,
            expectedIsEnabledValue: true,
            desc: 'Unset value',
            expectedSanitizedValue: undefined,
        },
    ]

    describe('isTelemetryEnabled', function () {
        scenarios.forEach(scenario => {
            it(scenario.desc, async () => {
                await settings.update(SETTING_KEY, scenario.initialSettingValue)

                assert.strictEqual(sut.isEnabled(), scenario.expectedIsEnabledValue)
            })
        })
    })

    describe('sanitizeTelemetrySetting', function () {
        scenarios.forEach(scenario => {
            it(scenario.desc, () => {
                const tryConvert = () => {
                    try {
                        return convertLegacy(scenario.initialSettingValue)
                    } catch {
                        return scenario.initialSettingValue
                    }
                }

                assert.deepStrictEqual(tryConvert(), scenario.expectedSanitizedValue)
            })
        })
    })
})

describe('hasUserSeenTelemetryNotice', async function () {
    let extensionContext: vscode.ExtensionContext
    let sandbox: sinon.SinonSandbox

    before(function () {
        sandbox = sinon.createSandbox()
    })

    after(function () {
        sandbox.restore()
    })

    beforeEach(async function () {
        extensionContext = await FakeExtensionContext.create()
    })

    it('is affected by setHasUserSeenTelemetryNotice', async function () {
        assert.ok(!hasUserSeenTelemetryNotice(extensionContext))
        await setHasUserSeenTelemetryNotice(extensionContext)
        assert.ok(hasUserSeenTelemetryNotice(extensionContext))
    })

    const scenarios = [
        { currentState: undefined, expectedHasSeen: false, desc: 'never seen before' },
        { currentState: 0, expectedHasSeen: false, desc: 'seen an older version' },
        { currentState: 2, expectedHasSeen: true, desc: 'seen the current version' },
        { currentState: 9999, expectedHasSeen: true, desc: 'seen a future version' },
    ]

    scenarios.forEach(scenario => {
        it(scenario.desc, async () => {
            await extensionContext.globalState.update(TELEMETRY_NOTICE_VERSION_ACKNOWLEDGED, scenario.currentState)
            assert.strictEqual(hasUserSeenTelemetryNotice(extensionContext), scenario.expectedHasSeen)
        })
    })
})
