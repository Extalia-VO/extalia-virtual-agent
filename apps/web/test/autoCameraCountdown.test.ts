import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {MESSAGES} from '../src/i18n';
import {AutoCameraCountdown} from '../src/office/AutoCameraCountdown';
it.each(['en','id'] as const)('shows localized passive countdown, safe target text and hides without a forecast (%s)',language=>{
 const t=MESSAGES[language];expect(renderToStaticMarkup(createElement(AutoCameraCountdown,{t,countdown:null}))).toBe('');
 const html=renderToStaticMarkup(createElement(AutoCameraCountdown,{t,countdown:{targetId:'example',seconds:10,windowSeconds:10},name:'Example <script>agent</script>'}));
 expect(html).toContain(t.office.autoCameraCountdown(10));expect(html).toContain(t.office.autoCameraNext);expect(html).toContain('role="timer"');expect(html).toContain('aria-live="off"');expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');expect(html).not.toContain('<button');
});
