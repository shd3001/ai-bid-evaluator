/** 关于页：把"谁算什么"的边界写在界面上，避免用户误会前端在做判定。 */
import { useSession } from "../app/session";
import { CopyId, Disclosure, Panel, StatusFlag } from "../components/core";
import { DetailList } from "../components/layout";
import { href } from "../utils/router";

const NOT_FRONTEND: Array<{ topic: string; owner: string; detail: string }> = [
  { topic: "分值计算", owner: "后端评分规则", detail: "得分、满分、总分都由后端算出并以十进制字符串返回；界面只做数字分组展示。" },
  { topic: "资格判定", owner: "后端资格规则", detail: "passed / failed / needs_review 三态由后端给出；缺信息不会被界面猜成通过。" },
  { topic: "排名与推荐集合", owner: "后端", detail: "资格未通过时后端会标 reference_only，界面如实显示「仅参考」。" },
  { topic: "报告版本与失效", owner: "后端", detail: "revision、confirmed、stale 全部来自后端；材料变化后由后端把旧报告标为 stale。" },
  { topic: "复核是否生效", owner: "后端", detail: "复核提交带 expected_version，冲突由后端返回 409，界面不会自动覆盖。" },
];

export function AboutView() {
  const { mode, healthReason } = useSession();
  return (
    <div className="view view--about">
      <header className="view__head">
        <div>
          <p className="micro muted">说明</p>
          <h1 className="view__title">关于评审台</h1>
          <p className="view__lead muted">
            这是一个只做"呈现与提交"的前端：它把后端的判断显示清楚，把人的决定带回去，但不替后端做任何业务判断。
          </p>
        </div>
      </header>

      <Panel eyebrow="边界" title="谁算什么">
        <ul className="boundary-list">
          {NOT_FRONTEND.map((item) => (
            <li key={item.topic} className="boundary">
              <div className="boundary__head">
                <strong>{item.topic}</strong>
                <StatusFlag tone="seal">{item.owner}</StatusFlag>
              </div>
              <p className="muted">{item.detail}</p>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel eyebrow="连接" title="当前运行方式">
        <DetailList
          columns={2}
          items={[
            {
              label: "模式",
              value:
                mode === "demo" ? (
                  <StatusFlag tone="review">离线演示数据（只读）</StatusFlag>
                ) : (
                  <StatusFlag tone="pass">连接真实后端</StatusFlag>
                ),
            },
            {
              label: "后端地址",
              value: <span className="mono">{"同源 /api/v1（开发期由 Vite 代理到 127.0.0.1:8000）"}</span>,
            },
          ]}
        />
        {healthReason ? <p className="muted">回落说明：{healthReason}</p> : null}
        <p className="muted">
          开发期前端把 <code className="mono">/api</code> 代理到 <code className="mono">http://127.0.0.1:8000</code>
          ；界面里任何数值都来自该后端的响应。
        </p>
        <CopyId value="uvicorn ai_bid_evaluator.api.app:create_app --factory --host 127.0.0.1 --port 8000" label="后端启动命令" prefix="$" />
      </Panel>

      <Panel eyebrow="操作" title="已知限制" tone="quiet">
        <ul className="tight-list">
          <li>后端没有"列出项目材料"的接口，所以材料清单是本机浏览器记录的回执，权威信息以 document_id 查询结果为准。</li>
          <li>后端同样没有"列出投标人"的接口，登记结果只在本次会话显示。</li>
          <li>API 不会自动启动 worker：创建运行后，需要 worker 在跑，状态才会从 pending 前进。</li>
          <li>复核与改分会使用于该 revision 的报告失效；界面不会挽留旧报告。</li>
        </ul>
        <Disclosure summary="这个界面刻意不做的事">
          <ul className="tight-list">
            <li>不按文件名把结论和材料关联：关联只走 document_id / chunk_id / 页码。</li>
            <li>不在未知总步骤时编造百分比：known_steps 为空就明确说「后端未给出总步数」。</li>
            <li>不静默重试写操作：幂等键由内容指纹决定，内容变了就换新键。</li>
          </ul>
        </Disclosure>
        <p className="micro muted">
          <a className="link" href={href("/projects")}>
            回到项目列表
          </a>
        </p>
      </Panel>
    </div>
  );
}

export function NotFoundView() {
  return (
    <div className="view view--404">
      <header className="view__head">
        <div>
          <p className="micro muted">404</p>
          <h1 className="view__title">这个地址没有对应页面</h1>
          <p className="view__lead muted">
            界面用的是 hash 路由（<code className="mono">#/projects</code> 这样的地址）。地址可能是手输错了，或者对应的运行已被清理。
          </p>
        </div>
      </header>
      <Panel eyebrow="去处" title="从这里继续">
        <div className="row gap-12 wrap">
          <a className="btn btn--primary" href={href("/projects")}>
            项目列表
          </a>
          <a className="btn btn--default" href={href("/opportunity")}>
            机会雷达
          </a>
          <a className="btn btn--default" href={href("/about")}>
            关于本界面
          </a>
        </div>
      </Panel>
    </div>
  );
}
