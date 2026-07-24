// A fire-and-forget business-metric sink (peer of Logger). Implementations MUST NOT throw —
// a metrics failure must never fail the use case it rides along with. The lambda composition
// root backs this with an EMF (CloudWatch Embedded Metric Format) stdout writer; tests use the
// null/capturing fakes. One method today (a monotonic event counter); grow it only when a real
// per-dimension or value-bearing need appears (YAGNI).
export interface Metrics {
  count(name: string): void;
}
