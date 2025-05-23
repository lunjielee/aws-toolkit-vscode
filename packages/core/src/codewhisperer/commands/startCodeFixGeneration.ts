/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { fs } from '../../shared/fs/fs'
import { getLogger } from '../../shared/logger/logger'
import {
    createCodeFixJob,
    getCodeFixJob,
    getPresignedUrlAndUpload,
    pollCodeFixJobStatus,
    throwIfCancelled,
} from '../service/codeFixHandler'
import { ArtifactMap, DefaultCodeWhispererClient } from '../client/codewhisperer'
import { codeFixState, CodeScanIssue } from '../models/model'
import { CreateCodeFixError } from '../models/errors'
import AdmZip from 'adm-zip'
import path from 'path'
import { TelemetryHelper } from '../util/telemetryHelper'
import { tempDirPath } from '../../shared/filesystemUtilities'
import { CodeWhispererSettings } from '../util/codewhispererSettings'
import { AuthUtil } from '../util/authUtil'
import { saveDocumentIfDirty } from '../../shared/utilities/textDocumentUtilities'

export async function startCodeFixGeneration(
    client: DefaultCodeWhispererClient,
    issue: CodeScanIssue,
    filePath: string,
    codeFixName: string
) {
    const profile = AuthUtil.instance.regionProfileManager.activeRegionProfile
    /**
     * Step 0: Initial code fix telemetry
     */
    // TODO: Telemetry
    let jobId
    let linesOfFixGenerated
    let charsOfFixGenerated
    try {
        getLogger().verbose(
            `Starting code fix generation for lines ${issue.startLine + 1} through ${issue.endLine} of file ${filePath}`
        )

        /**
         * Step 1: Generate zip
         */
        throwIfCancelled()

        // Save the file if it has unsaved changes to ensure the latest content is included in the zip
        await saveDocumentIfDirty(filePath)
        const admZip = new AdmZip()
        admZip.addLocalFile(filePath)

        const zipFilePath = path.join(tempDirPath, 'codefix.zip')
        admZip.writeZip(zipFilePath)

        /**
         * Step 2: Get presigned Url, upload and clean up
         */
        let artifactMap: ArtifactMap = {}
        try {
            artifactMap = await getPresignedUrlAndUpload(client, zipFilePath, codeFixName, profile)
        } finally {
            await fs.delete(zipFilePath)
        }

        /**
         * Step 3: Create code fix job
         */
        throwIfCancelled()
        const codeFixJob = await createCodeFixJob(
            client,
            artifactMap.SourceCode,
            {
                start: { line: issue.startLine + 1, character: 0 },
                end: { line: issue.endLine, character: 0 },
            },
            issue.recommendation.text,
            {
                recommendationsWithReferences: CodeWhispererSettings.instance.isSuggestionsWithCodeReferencesEnabled()
                    ? 'ALLOW'
                    : 'BLOCK',
            },
            codeFixName,
            issue.ruleId,
            profile
        )
        if (codeFixJob.status === 'Failed') {
            throw new CreateCodeFixError()
        }
        jobId = codeFixJob.jobId
        issue.fixJobId = codeFixJob.jobId
        getLogger().verbose(`Created code fix job.`)

        /**
         * Step 4: Polling mechanism on code fix job status
         */
        throwIfCancelled()
        const jobStatus = await pollCodeFixJobStatus(client, String(codeFixJob.jobId), profile)
        if (jobStatus === 'Failed') {
            getLogger().verbose(`Code fix generation failed.`)
            throw new CreateCodeFixError()
        }

        /**
         * Step 5: Process and render code fix results
         */
        throwIfCancelled()
        getLogger().verbose(`Code fix job succeeded and start processing result.`)

        const { suggestedFix } = await getCodeFixJob(client, String(codeFixJob.jobId), profile)
        // eslint-disable-next-line aws-toolkits/no-json-stringify-in-log
        getLogger().verbose(`Suggested fix: ${JSON.stringify(suggestedFix)}`)
        return { suggestedFix, jobId }
    } catch (err) {
        getLogger().error('Code fix generation failed: %s', err)
        throw err
    } finally {
        codeFixState.setToNotStarted()
        if (jobId) {
            TelemetryHelper.instance.sendCodeFixGenerationEvent(
                jobId,
                issue.language,
                issue.ruleId,
                issue.detectorId,
                linesOfFixGenerated,
                charsOfFixGenerated
            )
        }
    }
}
