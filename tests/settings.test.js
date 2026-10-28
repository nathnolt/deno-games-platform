// Settings groups. Run with: deno run tests/settings.test.js
import { defaultSettings, sanitizeSettings, groupSettings } from '../shared/settings.js';

const ok = (cond, msg) => {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('ok  -', msg);
};

const meta = {
  settingGroups: [
    { id: 'rules', label: 'Rules' },
    { id: 'empty', label: 'Nothing here' },
    { id: 'bots', label: 'Bots', collapsed: true },
  ],
  settings: [
    { type: 'number', key: 'a', label: 'A', min: 1, max: 5, default: 3 },
    { type: 'boolean', key: 'b', label: 'B', group: 'bots', default: true },
    { type: 'number', key: 'c', label: 'C', group: 'rules', min: 0, max: 9, default: 1 },
    { type: 'boolean', key: 'd', label: 'D', group: 'undeclared', default: false },
    { type: 'boolean', key: 'e', label: 'E', group: 'rules', default: false },
  ],
};

const { loose, groups } = groupSettings(meta);
ok(loose.map((f) => f.key).join() === 'a', 'fields without a group stay loose');
ok(groups.map((g) => g.id).join() === 'rules,bots,undeclared', 'declared order is kept, empty groups skipped, undeclared groups appended');
ok(groups[0].fields.map((f) => f.key).join() === 'c,e', 'fields keep their schema order inside a group');
ok(groups[1].collapsed === true && groups[2].label === 'undeclared', 'collapsed is carried over; undeclared group is titled by its id');

ok(Object.keys(defaultSettings(meta)).join() === 'a,b,c,d,e', 'defaults stay a flat object regardless of groups');
ok(sanitizeSettings(meta, { a: 99, c: -4 }).a === 5, 'sanitize still clamps grouped fields');
ok(groupSettings({ settings: meta.settings.slice(0, 1) }).groups.length === 0, 'meta without settingGroups still works');
console.log('settings tests passed');
