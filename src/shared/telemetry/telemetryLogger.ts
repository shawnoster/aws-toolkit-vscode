/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { getLogger } from '../logger'
import { isReleaseVersion } from '../vscode/env'
import { MetricDatum, MetadataEntry } from './clienttelemetry'

export interface MetricQuery {
    /** Metric name to look up in the log */
    readonly metricName: string
    /** Attributes to filter out of the metadata */
    readonly filters?: string[]
}

interface Metadata {
    [key: string]: string | undefined
}

function isValidEntry(datum: MetadataEntry): datum is Required<MetadataEntry> {
    return datum.Key !== undefined && datum.Value !== undefined
}

/**
 * Telemetry currently sends metadata as an array of key/value pairs, but this is unintuitive for JS
 */
const mapMetadata = (filters: string[]) => (metadata: Required<MetricDatum>['Metadata']) => {
    const result: Metadata = {}
    return metadata
        .filter(isValidEntry)
        .filter(a => !filters.includes(a.Key))
        .reduce((a, b) => ((a[b.Key] = b.Value), a), result)
}

/**
 * Simple class to log queryable metrics.
 *
 * Does not track any other telemetry APIs such as feedback.
 */
export class TelemetryLogger {
    private readonly _metrics: MetricDatum[] = []

    public get metricCount(): number {
        return this._metrics.length
    }

    public log(metric: MetricDatum): void {
        const msg = `telemetry: emitted metric "${metric.MetricName}"`
        if (!isReleaseVersion()) {
            this._metrics.push(metric)
            const stringified = JSON.stringify(metric)
            getLogger().debug(`${msg} -> ${stringified}`)
        } else {
            getLogger().debug(msg)
        }
    }

    /**
     * Queries against the log, returning matched entries.
     * Only returns the metadata. See {@link queryFull} for getting the entire metric.
     *
     * **All metadata values are casted to strings by the telemetry client**
     */
    public query(query: MetricQuery): Metadata[] {
        return this.queryFull(query)
            .map(m => m.Metadata ?? [])
            .map(mapMetadata(query.filters ?? []))
    }

    /**
     * Queries telemetry for metrics, returning the entire structure.
     */
    public queryFull(query: MetricQuery): MetricDatum[] {
        return this._metrics.filter(m => m.MetricName === query.metricName)
    }
}
