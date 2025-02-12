/*! * Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved. * SPDX-License-Identifier: Apache-2.0 */

<template>
    <div :id="id">
        <h1>Feedback for AWS Toolkit</h1>

        <h3 id="sentiment-heading">How was your experience?</h3>
        <div>
            <input id="positive-sentiment" type="radio" value="Positive" v-model="sentiment" />
            <label for="positive-sentiment"></label>
            <input id="negative-sentiment" type="radio" value="Negative" v-model="sentiment" />
            <label for="negative-sentiment"></label>
        </div>

        <h3 id="feedback-heading">Feedback</h3>

        <div>
            <textarea style="width: 100%" rows="10" cols="90" v-model="comment"></textarea>
            <div>
                <div
                    style="float: right; font-size: smaller"
                    id="remaining"
                    :class="comment.length > 2000 ? 'exceeds-max-length' : ''"
                >
                    {{ 2000 - comment.length }} characters remaining
                </div>
                <div>
                    <em
                        >Feedback is <b>anonymous</b>. If you need a reply,
                        <a href="https://github.com/aws/aws-toolkit-vscode/issues/new/choose">contact us on GitHub</a
                        >.</em
                    >
                </div>
            </div>
        </div>

        <p>
            <input v-if="isSubmitting" type="submit" value="Submitting..." disabled />
            <input
                v-else
                type="submit"
                @click="submitFeedback"
                :disabled="comment.length === 0 || comment.length > 2000 || sentiment === ''"
                value="Submit"
            />
        </p>

        <div id="error" v-if="error !== ''">
            <strong>{{ error }}</strong>
        </div>
    </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { WebviewClientFactory } from '../../webviews/client'
import saveData from '../../webviews/mixins/saveData'
import { FeedbackWebview } from '../commands/submitFeedback'

const client = WebviewClientFactory.create<FeedbackWebview>()

export default defineComponent({
    setup() {
        console.log('Loaded!')
    },
    data() {
        return {
            comment: '',
            sentiment: '',
            isSubmitting: false,
            error: '',
        }
    },
    mounted() {
        this.$nextTick(function () {
            window.addEventListener('message', this.handleMessageReceived)
        })
    },
    methods: {
        handleMessageReceived(e: MessageEvent) {
            const message = e.data
            switch (message.statusCode) {
                case 'Failure':
                    console.error(`Failed to submit feedback: ${message.error}`)
                    this.error = message.error
                    this.isSubmitting = false
                    break
            }
        },
        submitFeedback() {
            this.error = ''
            this.isSubmitting = true
            console.log('Submitting feedback...')
            client.feedback({
                comment: this.comment,
                sentiment: this.sentiment,
            })
        },
    },
    mixins: [saveData],
})
</script>
