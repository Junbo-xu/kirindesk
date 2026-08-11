import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { CustomsDocumentType, CustomsPdfSnapshot } from './customs-declarations.types';

export const CUSTOMS_PDF_RENDERER = Symbol('CUSTOMS_PDF_RENDERER');

export interface CustomsPdfRenderer {
  render(snapshot: CustomsPdfSnapshot, documentType: CustomsDocumentType): Promise<Buffer>;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function detail(label: string, value: unknown): string {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

export function renderCustomsHtml(
  snapshot: CustomsPdfSnapshot,
  documentType: CustomsDocumentType,
): string {
  const data = snapshot.data;
  const title = documentType === 'pre_entry' ? '报关单预录单样单' : '报关委托书';
  const lines = data.lines
    .map(
      (line) =>
        `<tr><td>${line.line_no}</td><td>${escapeHtml(line.product_code)}</td><td>${escapeHtml(line.description)}</td><td>${escapeHtml(line.hs_code)}</td><td>${escapeHtml(line.declaration_elements)}</td><td>${escapeHtml(line.quantity)} ${escapeHtml(line.unit)}</td><td>${escapeHtml(line.currency)} ${escapeHtml(line.unit_price)}</td><td>${escapeHtml(line.currency)} ${escapeHtml(line.line_total)}</td><td>${escapeHtml(line.package_no)}</td><td>${escapeHtml(line.net_weight_kg)}</td></tr>`,
    )
    .join('');
  const declarationBody = `<section class="grid">${detail('申报口岸', data.port)}${detail('贸易方式', data.trade_mode)}${detail('包装种类', data.package_type)}${detail('件数', data.package_count)}${detail('毛重（kg）', data.gross_weight_kg)}${detail('净重（kg）', data.net_weight_kg)}${detail('币种', data.currency)}${detail('总金额', data.total_amount)}</section><table><thead><tr><th>#</th><th>商品编码</th><th>商品名称</th><th>HS 编码</th><th>申报要素</th><th>数量</th><th>单价</th><th>总价</th><th>包装</th><th>净重</th></tr></thead><tbody>${lines}</tbody></table>`;
  const authorizationBody = `<section class="party"><h2>委托方</h2>${detail('名称', data.consignor.name)}${detail('统一社会信用代码', data.consignor.uscc)}${detail('联系人', data.consignor.contact)}${detail('联系电话', data.consignor.phone)}</section><section class="party"><h2>报关行</h2>${detail('名称', data.customs_broker.name)}${detail('统一社会信用代码', data.customs_broker.uscc)}${detail('联系人', data.customs_broker.contact)}${detail('联系电话', data.customs_broker.phone)}</section><section><h2>授权事项</h2><ol>${data.authorization_matters.map((matter) => `<li>${escapeHtml(matter)}</li>`).join('')}</ol></section><section class="statement">委托方授权报关行依据本委托书及归档来源资料办理与销售订单 ${escapeHtml(data.order_number)} 有关的报关事项。报关行应核对申报资料并保留业务凭证。</section><section class="signatures"><div>委托方（盖章）：</div><div>报关行（盖章）：</div></section>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>@page{size:A4 landscape;margin:12mm}*{box-sizing:border-box}body{font-family:"Noto Sans CJK SC","Microsoft YaHei","Arial Unicode MS",sans-serif;color:#172033;font-size:10px;margin:0}header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #155eef;padding-bottom:10px;margin-bottom:14px}h1{font-size:22px;margin:0;color:#155eef}h2{font-size:14px;margin:14px 0 8px}.meta{text-align:right;color:#475569}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px}.grid div,.party div{border:1px solid #cbd5e1;padding:7px}.grid span,.party span{display:block;color:#64748b;font-size:9px}.grid strong,.party strong{display:block;margin-top:3px}.party{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.party h2{grid-column:1/-1}table{width:100%;border-collapse:collapse;table-layout:auto}th,td{border:1px solid #94a3b8;padding:5px;vertical-align:top}th{background:#e2e8f0}.statement{margin-top:22px;line-height:1.8;border:1px solid #cbd5e1;padding:12px}.signatures{display:grid;grid-template-columns:1fr 1fr;gap:80px;margin-top:60px;font-size:13px}ol{line-height:1.8}footer{position:fixed;bottom:0;color:#64748b;font-size:8px}</style></head><body><header><div><h1>${title}</h1><div>${escapeHtml(data.declaration_number)}</div></div><div class="meta">订单 ${escapeHtml(data.order_number)} · 归档版本 v${snapshot.version}<br>${escapeHtml(snapshot.generated_at)}</div></header>${documentType === 'pre_entry' ? declarationBody : authorizationBody}<footer>KirinDesk · 来源快照指纹随归档版本保存</footer></body></html>`;
}

@Injectable()
export class PuppeteerCustomsPdfRenderer implements CustomsPdfRenderer {
  private executablePath(): string {
    const candidates = [
      process.env.CHROMIUM_EXECUTABLE_PATH,
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium',
    ].filter((value): value is string => Boolean(value));
    const executable = candidates.find((candidate) => existsSync(candidate));
    if (!executable) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'PDF_RENDERER_UNAVAILABLE',
        message: 'Chromium PDF renderer is unavailable',
      });
    }
    return executable;
  }

  async render(snapshot: CustomsPdfSnapshot, documentType: CustomsDocumentType): Promise<Buffer> {
    const browser = await puppeteer.launch({
      executablePath: this.executablePath(),
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage();
      await page.setContent(renderCustomsHtml(snapshot, documentType), { waitUntil: 'load' });
      const pdf = await page.pdf({ format: 'A4', landscape: true, printBackground: true });
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }
}
