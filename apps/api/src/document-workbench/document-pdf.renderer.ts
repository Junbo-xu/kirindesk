import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { buildDocumentPackages } from './document-packing';
import { DocumentRenderAssets, DocumentType, PublicDocumentSnapshot } from './document.types';

export const DOCUMENT_PDF_RENDERER = Symbol('DOCUMENT_PDF_RENDERER');

export interface DocumentPdfRenderer {
  render(
    snapshot: PublicDocumentSnapshot,
    documentType: DocumentType,
    assets: DocumentRenderAssets,
  ): Promise<Buffer>;
}

const LABELS = {
  zh: {
    titles: { quote: '报价单', pi: '形式发票', sc: '销售合同', ci: '商业发票', pl: '装箱单' },
    draft: '草稿',
    customer: '客户',
    contact: '联系人',
    number: '单号',
    terms: '条款',
    bank: '银行信息',
    total: '合计',
    subtotal: '小计',
    discount: '折扣',
    freight: '运费',
    insurance: '保险',
    tax: '税费',
    settlement: '结算金额',
    sku: 'SKU',
    product: '产品',
    quantity: '数量',
    unit: '单位',
    price: '单价',
    amount: '金额',
    package: '箱号',
    weight: '重量(kg)',
    volume: '体积(CBM)',
    confirmed: '已锁定快照',
  },
  en: {
    titles: {
      quote: 'QUOTATION',
      pi: 'PROFORMA INVOICE',
      sc: 'SALES CONTRACT',
      ci: 'COMMERCIAL INVOICE',
      pl: 'PACKING LIST',
    },
    draft: 'DRAFT',
    customer: 'Customer',
    contact: 'Contact',
    number: 'Number',
    terms: 'Terms',
    bank: 'Bank information',
    total: 'Total',
    subtotal: 'Subtotal',
    discount: 'Discount',
    freight: 'Freight',
    insurance: 'Insurance',
    tax: 'Tax',
    settlement: 'Settlement total',
    sku: 'SKU',
    product: 'Product',
    quantity: 'Quantity',
    unit: 'Unit',
    price: 'Unit price',
    amount: 'Amount',
    package: 'Package',
    weight: 'Weight (kg)',
    volume: 'Volume (CBM)',
    confirmed: 'LOCKED SNAPSHOT',
  },
  ru: {
    titles: {
      quote: 'КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ',
      pi: 'ПРОФОРМА-ИНВОЙС',
      sc: 'ДОГОВОР КУПЛИ-ПРОДАЖИ',
      ci: 'КОММЕРЧЕСКИЙ ИНВОЙС',
      pl: 'УПАКОВОЧНЫЙ ЛИСТ',
    },
    draft: 'ЧЕРНОВИК',
    customer: 'Клиент',
    contact: 'Контакт',
    number: 'Номер',
    terms: 'Условия',
    bank: 'Банковские реквизиты',
    total: 'Итого',
    subtotal: 'Подытог',
    discount: 'Скидка',
    freight: 'Фрахт',
    insurance: 'Страхование',
    tax: 'Налог',
    settlement: 'Сумма расчета',
    sku: 'SKU',
    product: 'Товар',
    quantity: 'Количество',
    unit: 'Ед.',
    price: 'Цена',
    amount: 'Сумма',
    package: 'Место',
    weight: 'Вес (кг)',
    volume: 'Объем (м³)',
    confirmed: 'ЗАФИКСИРОВАНО',
  },
  es: {
    titles: {
      quote: 'COTIZACIÓN',
      pi: 'FACTURA PROFORMA',
      sc: 'CONTRATO DE VENTA',
      ci: 'FACTURA COMERCIAL',
      pl: 'LISTA DE EMPAQUE',
    },
    draft: 'BORRADOR',
    customer: 'Cliente',
    contact: 'Contacto',
    number: 'Número',
    terms: 'Términos',
    bank: 'Información bancaria',
    total: 'Total',
    subtotal: 'Subtotal',
    discount: 'Descuento',
    freight: 'Flete',
    insurance: 'Seguro',
    tax: 'Impuesto',
    settlement: 'Total de liquidación',
    sku: 'SKU',
    product: 'Producto',
    quantity: 'Cantidad',
    unit: 'Unidad',
    price: 'Precio unitario',
    amount: 'Importe',
    package: 'Bulto',
    weight: 'Peso (kg)',
    volume: 'Volumen (CBM)',
    confirmed: 'COPIA BLOQUEADA',
  },
  de: {
    titles: {
      quote: 'ANGEBOT',
      pi: 'PROFORMARECHNUNG',
      sc: 'KAUFVERTRAG',
      ci: 'HANDELSRECHNUNG',
      pl: 'PACKLISTE',
    },
    draft: 'ENTWURF',
    customer: 'Kunde',
    contact: 'Kontakt',
    number: 'Nummer',
    terms: 'Bedingungen',
    bank: 'Bankverbindung',
    total: 'Gesamt',
    subtotal: 'Zwischensumme',
    discount: 'Rabatt',
    freight: 'Fracht',
    insurance: 'Versicherung',
    tax: 'Steuer',
    settlement: 'Abrechnungsbetrag',
    sku: 'SKU',
    product: 'Produkt',
    quantity: 'Menge',
    unit: 'Einheit',
    price: 'Stückpreis',
    amount: 'Betrag',
    package: 'Packstück',
    weight: 'Gewicht (kg)',
    volume: 'Volumen (CBM)',
    confirmed: 'GESPERRTE KOPIE',
  },
  ar: {
    titles: {
      quote: 'عرض سعر',
      pi: 'فاتورة أولية',
      sc: 'عقد بيع',
      ci: 'فاتورة تجارية',
      pl: 'قائمة التعبئة',
    },
    draft: 'مسودة',
    customer: 'العميل',
    contact: 'جهة الاتصال',
    number: 'الرقم',
    terms: 'الشروط',
    bank: 'المعلومات المصرفية',
    total: 'الإجمالي',
    subtotal: 'المجموع الفرعي',
    discount: 'الخصم',
    freight: 'الشحن',
    insurance: 'التأمين',
    tax: 'الضريبة',
    settlement: 'إجمالي التسوية',
    sku: 'SKU',
    product: 'المنتج',
    quantity: 'الكمية',
    unit: 'الوحدة',
    price: 'سعر الوحدة',
    amount: 'المبلغ',
    package: 'الطرد',
    weight: 'الوزن (كجم)',
    volume: 'الحجم (م³)',
    confirmed: 'نسخة مقفلة',
  },
} as const;

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function visible(snapshot: PublicDocumentSnapshot, field: string): boolean {
  return snapshot.visible_fields[field] !== false;
}

export function renderDocumentHtml(
  snapshot: PublicDocumentSnapshot,
  documentType: DocumentType,
  assets: DocumentRenderAssets,
): string {
  const labels = LABELS[snapshot.language];
  const rtl = snapshot.language === 'ar';
  const packingList = documentType === 'pl';
  const customFields = new Map<string, string>();
  for (const line of snapshot.lines) {
    for (const field of line.custom_fields) {
      if (field.document_types.includes(documentType))
        customFields.set(field.field_key, field.label);
    }
  }
  const customColumns = [...customFields.entries()];
  const itemRows = snapshot.lines
    .map((line) => {
      const custom = new Map(line.custom_fields.map((field) => [field.field_key, field.value]));
      const thumbnail = line.thumbnail_file_id
        ? assets.thumbnails[line.thumbnail_file_id]
        : undefined;
      return `<tr><td>${line.line_no}</td>${visible(snapshot, 'thumbnail') ? `<td>${thumbnail ? `<img class="thumb" src="${escapeHtml(thumbnail)}">` : ''}</td>` : ''}<td>${escapeHtml(line.sku)}</td><td><strong>${escapeHtml(line.name)}</strong>${line.description ? `<br><span class="muted">${escapeHtml(line.description)}</span>` : ''}</td><td>${escapeHtml(line.quantity)}</td><td>${escapeHtml(line.unit)}</td>${packingList ? `<td>${escapeHtml(line.package_no || '-')}</td><td>${escapeHtml(line.total_weight_kg || '0.0000')}</td><td>${escapeHtml(line.total_volume_cbm || '0.000000')}</td>` : `<td>${escapeHtml(snapshot.pricing_currency)} ${escapeHtml(line.unit_price)}</td><td>${escapeHtml(snapshot.pricing_currency)} ${escapeHtml(line.line_total)}</td>`}${customColumns.map(([key]) => `<td>${escapeHtml(custom.get(key) ?? '')}</td>`).join('')}</tr>`;
    })
    .join('');
  const lineByNumber = new Map(snapshot.lines.map((line) => [line.line_no, line]));
  const packages =
    snapshot.packages ?? buildDocumentPackages(snapshot.lines, snapshot.packing_mode);
  const packingRows = packages
    .map((documentPackage, packageIndex) => {
      const packageLines = documentPackage.line_nos
        .map((lineNumber) => lineByNumber.get(lineNumber))
        .filter((line): line is PublicDocumentSnapshot['lines'][number] => Boolean(line));
      const values = (value: (line: PublicDocumentSnapshot['lines'][number]) => unknown) =>
        packageLines.map((line) => escapeHtml(value(line))).join('<br>');
      const thumbnails = packageLines
        .map((line) => (line.thumbnail_file_id ? assets.thumbnails[line.thumbnail_file_id] : null))
        .filter((thumbnail): thumbnail is string => Boolean(thumbnail))
        .map((thumbnail) => `<img class="thumb" src="${escapeHtml(thumbnail)}">`)
        .join('');
      return `<tr><td>${packageIndex + 1}</td>${visible(snapshot, 'thumbnail') ? `<td>${thumbnails}</td>` : ''}<td>${values((line) => line.sku)}</td><td>${values((line) => `${line.name}${line.description ? ` — ${line.description}` : ''}`)}</td><td>${values((line) => line.quantity)}</td><td>${values((line) => line.unit)}</td><td>${escapeHtml(documentPackage.package_no)}</td><td>${escapeHtml(documentPackage.total_weight_kg)}</td><td>${escapeHtml(documentPackage.total_volume_cbm)}</td>${customColumns.map(([key]) => `<td>${values((line) => line.custom_fields.find((field) => field.field_key === key)?.value ?? '')}</td>`).join('')}</tr>`;
    })
    .join('');
  const rows = packingList ? packingRows : itemRows;
  const financialRows = packingList
    ? `<tr><th>${escapeHtml(labels.total)}</th><td>${escapeHtml(snapshot.totals.total_weight_kg)}</td><td>${escapeHtml(snapshot.totals.total_volume_cbm)}</td></tr>`
    : [
        [labels.subtotal, snapshot.totals.subtotal, 'subtotal'],
        [labels.discount, `-${snapshot.totals.discount_amount}`, 'discount'],
        [labels.freight, snapshot.totals.freight_amount, 'freight'],
        [labels.insurance, snapshot.totals.insurance_amount, 'insurance'],
        [labels.tax, snapshot.totals.tax_amount, 'tax'],
        [labels.total, snapshot.totals.grand_total, 'total'],
      ]
        .filter(([, , key]) => visible(snapshot, key))
        .map(
          ([label, value]) =>
            `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(snapshot.pricing_currency)} ${escapeHtml(value)}</td></tr>`,
        )
        .join('');
  const settlement =
    !packingList && snapshot.settlement_currency !== snapshot.pricing_currency
      ? `<p class="settlement">${escapeHtml(labels.settlement)}: <strong>${escapeHtml(snapshot.settlement_currency)} ${escapeHtml(snapshot.totals.settlement_total)}</strong> · 1 ${escapeHtml(snapshot.pricing_currency)} = ${escapeHtml(snapshot.exchange_rate)} ${escapeHtml(snapshot.settlement_currency)}</p>`
      : '';
  return `<!doctype html><html lang="${escapeHtml(snapshot.language)}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>@page{size:A4;margin:16mm 12mm}*{box-sizing:border-box}body{font-family:"Noto Sans","Noto Sans CJK SC","Arial Unicode MS",Arial,sans-serif;color:#172033;font-size:11px;margin:0}.header{display:flex;justify-content:space-between;gap:24px;border-bottom:3px solid ${escapeHtml(snapshot.theme_color)};padding-bottom:14px}.logo{max-width:150px;max-height:64px}.title{text-align:${rtl ? 'left' : 'right'}}h1{font-size:22px;color:${escapeHtml(snapshot.theme_color)};margin:0 0 8px}.watermark{position:fixed;top:44%;left:14%;transform:rotate(-28deg);font-size:72px;color:rgba(100,116,139,.13);font-weight:700;z-index:-1}.meta{display:grid;grid-template-columns:1fr 1fr;gap:8px 28px;margin:18px 0}.meta p{margin:0}.muted{color:#64748b}.items{width:100%;border-collapse:collapse;table-layout:auto}.items th{background:${escapeHtml(snapshot.theme_color)};color:white}.items th,.items td{border:1px solid #cbd5e1;padding:7px;vertical-align:top}.thumb{width:42px;height:42px;object-fit:contain}.summary{margin:16px 0 0 auto;border-collapse:collapse;min-width:280px}.summary th,.summary td{border-bottom:1px solid #cbd5e1;padding:6px;text-align:${rtl ? 'left' : 'right'}}.settlement{text-align:${rtl ? 'left' : 'right'}}.section{margin-top:20px;white-space:pre-wrap}.signature{max-width:150px;max-height:80px;margin-top:8px}.footer{margin-top:28px;color:#64748b;font-size:9px;border-top:1px solid #cbd5e1;padding-top:8px}</style></head><body>${snapshot.status === 'draft' ? `<div class="watermark">${escapeHtml(labels.draft)}</div>` : ''}<header class="header"><div>${assets.logo ? `<img class="logo" src="${escapeHtml(assets.logo)}">` : ''}</div><div class="title"><h1>${escapeHtml(labels.titles[documentType])}</h1><div>${escapeHtml(labels.number)}: ${escapeHtml(snapshot.quote_number)} · v${snapshot.source_version}</div><strong>${escapeHtml(snapshot.status === 'draft' ? labels.draft : labels.confirmed)}</strong></div></header><section class="meta"><p><strong>${escapeHtml(labels.customer)}:</strong> ${escapeHtml(snapshot.customer?.company_name || '-')}</p><p><strong>Incoterm:</strong> ${escapeHtml(snapshot.incoterm)}</p><p><strong>${escapeHtml(labels.contact)}:</strong> ${escapeHtml(snapshot.customer?.contact_name || '-')}</p><p><strong>Currency:</strong> ${escapeHtml(snapshot.pricing_currency)}</p></section><table class="items"><thead><tr><th>#</th>${visible(snapshot, 'thumbnail') ? '<th></th>' : ''}<th>${escapeHtml(labels.sku)}</th><th>${escapeHtml(labels.product)}</th><th>${escapeHtml(labels.quantity)}</th><th>${escapeHtml(labels.unit)}</th>${packingList ? `<th>${escapeHtml(labels.package)}</th><th>${escapeHtml(labels.weight)}</th><th>${escapeHtml(labels.volume)}</th>` : `<th>${escapeHtml(labels.price)}</th><th>${escapeHtml(labels.amount)}</th>`}${customColumns.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table><table class="summary">${financialRows}</table>${settlement}${snapshot.terms && visible(snapshot, 'terms') ? `<section class="section"><h3>${escapeHtml(labels.terms)}</h3>${escapeHtml(snapshot.terms)}</section>` : ''}${snapshot.bank_info && visible(snapshot, 'bank_info') ? `<section class="section"><h3>${escapeHtml(labels.bank)}</h3>${escapeHtml(snapshot.bank_info)}</section>` : ''}${assets.signature && visible(snapshot, 'signature') ? `<section class="section"><img class="signature" src="${escapeHtml(assets.signature)}"></section>` : ''}<footer class="footer">${escapeHtml(snapshot.quote_number)} · ${escapeHtml(snapshot.generated_at)}</footer></body></html>`;
}

@Injectable()
export class PuppeteerDocumentPdfRenderer implements DocumentPdfRenderer {
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

  async render(
    snapshot: PublicDocumentSnapshot,
    documentType: DocumentType,
    assets: DocumentRenderAssets,
  ): Promise<Buffer> {
    const browser = await puppeteer.launch({
      executablePath: this.executablePath(),
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage();
      await page.setContent(renderDocumentHtml(snapshot, documentType, assets), {
        waitUntil: 'load',
      });
      const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }
}
