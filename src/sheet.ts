import { t } from './i18n'
import { jsPDF } from 'jspdf'
import { renderSheetPrintPage } from './sheet-scroll'
import type { NoteEvent } from './types'

/**
 * Build a landscape A4 PDF using the same notation engine as the scrolling sheet.
 * Always printed on the light page theme.
 */
export async function songToSheetPdf(notes: NoteEvent[], title: string): Promise<Blob> {
  if (notes.length === 0) throw new Error(t('noNotesForSheet'))

  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4', compress: true })
  const pageW = pdf.internal.pageSize.getWidth()
  const pageH = pdf.internal.pageSize.getHeight()

  const marginX = 48
  const marginTop = 52
  const marginBottom = 36
  const contentW = pageW - marginX * 2
  const contentH = pageH - marginTop - marginBottom
  const systemsPerPage = 3

  // Probe page 0 for pagination metadata.
  const probe = renderSheetPrintPage(notes, {
    width: contentW,
    height: contentH,
    pageIndex: 0,
    systemsPerPage,
    showNames: false,
  })
  const { totalPages, bpm, timeSigLabel } = probe.info

  // Visible host so canvas text metrics resolve music glyphs.
  const host = document.createElement('div')
  host.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;opacity:0;pointer-events:none;overflow:visible;'
  document.body.appendChild(host)

  try {
    for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
      if (pageIndex > 0) pdf.addPage('a4', 'landscape')

      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(pageIndex === 0 ? 16 : 11)
      pdf.text(title || 'PianoSmith', pageW / 2, 26, { align: 'center' })
      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(9)
      pdf.text(`${bpm} BPM  |  ${timeSigLabel}  |  pag. ${pageIndex + 1}`, marginX, 26)

      const { canvas } =
        pageIndex === 0
          ? probe
          : renderSheetPrintPage(notes, {
              width: contentW,
              height: contentH,
              pageIndex,
              systemsPerPage,
              showNames: false,
            })
      host.appendChild(canvas)
      // Let the browser settle glyph rasterization before snapshot.
      await new Promise((resolve) => window.setTimeout(resolve, pageIndex === 0 ? 40 : 0))
      const img = canvas.toDataURL('image/png')
      pdf.addImage(img, 'PNG', marginX, marginTop, contentW, contentH)
      host.removeChild(canvas)
    }
  } finally {
    host.remove()
  }

  return pdf.output('blob')
}
