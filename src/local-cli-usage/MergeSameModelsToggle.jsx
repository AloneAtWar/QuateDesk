// 合并同名模型开关:热力图当日模型区和模型拆分页共用同一状态的两个呈现位置,
// 状态由父级持有并持久化到 settings,这里只做展示与回调。
export default function MergeSameModelsToggle({ checked, onChange, disabled }) {
  return <button
    type="button"
    className={`local-cli-merge-toggle${checked ? ' on' : ''}`}
    role="switch" aria-checked={checked} aria-label="合并同名模型"
    title="将不同 CLI 中的同名模型合并为一行;关闭后按渠道分行"
    disabled={disabled}
    onClick={() => onChange(!checked)}
  >
    <span className="local-cli-merge-track"><i className="local-cli-merge-knob" /></span>
    <span className="local-cli-merge-label">合并同名模型</span>
  </button>;
}
