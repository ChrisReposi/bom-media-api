import type { MariaDbCollationProbeService } from "./mariadb-collation-probe.service";

type UnexpectedProbeFailureHandler = () => void;

/** Launches the post-listen diagnostic without exposing its rejection. */
export function launchMariaDbCollationProbeAfterListen(
  probe: Pick<MariaDbCollationProbeService, "runOnceAfterListen">,
  onUnexpectedFailure: UnexpectedProbeFailureHandler,
): void {
  void probe.runOnceAfterListen().catch(() => onUnexpectedFailure());
}
