/** A job that waits longer than this for a machine adds queue time to the measured wait; the sample is replaced. */
export const DEFAULT_MAX_JOB_QUEUE_SECONDS = 30

/** Tracks the longest runner wait in one sample and the reasons any job exceeded the limit. */
export class QueueTracker {
  maxSeconds: number | null = null
  maxLabel: string | null = null
  readonly reasons: string[] = []

  readonly limitSeconds: number

  constructor(limitSeconds: number = DEFAULT_MAX_JOB_QUEUE_SECONDS) {
    this.limitSeconds = limitSeconds
  }

  record(queueSeconds: number | null, labels: string[]): void {
    if (queueSeconds === null) return
    const label = labels.join(',') || 'unknown'
    if (this.maxSeconds === null || queueSeconds > this.maxSeconds) {
      this.maxSeconds = queueSeconds
      this.maxLabel = label
    }
    if (queueSeconds > this.limitSeconds) this.reasons.push(`queued ${queueSeconds} s for a runner (label ${label})`)
  }
}
