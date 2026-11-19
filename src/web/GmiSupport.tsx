import { translate } from './locale';

export function GmiSupport() {
  return (
    <div className="gmi-support">
      <a
        className="gmi-mark"
        href="https://www.gmicloud.ai/en/company/ambassador-program"
        target="_blank"
        rel="noreferrer"
      >
        <img src="/brand/gmi-clouder.svg" alt="GMI Clouder" width={100} />
      </a>
      <p>
        <strong>{translate('GMI Cloud 提供模型推理')}</strong>
        <span>{translate('用于对话、录音分析和后台查询。')}</span>
      </p>
    </div>
  );
}
