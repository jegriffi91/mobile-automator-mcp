import { describe, it, expect } from 'vitest';
import { parseAttributes, parseBoundsString, parseCsvHierarchy } from './csv-hierarchy-parser.js';

describe('parseAttributes', () => {
  it('should parse semicolon-separated key=value pairs', () => {
    const input = 'accessibilityText=VILLAIN OS; resource-id=login_title; enabled=true';
    const result = parseAttributes(input);

    expect(result['accessibilityText']).toBe('VILLAIN OS');
    expect(result['resource-id']).toBe('login_title');
    expect(result['enabled']).toBe('true');
  });

  it('should handle empty string', () => {
    expect(parseAttributes('')).toEqual({});
  });

  it('should handle values containing equals signs', () => {
    const input = 'text=a=b; resource-id=field1';
    const result = parseAttributes(input);
    expect(result['text']).toBe('a=b');
    expect(result['resource-id']).toBe('field1');
  });

  it('should handle whitespace-only input', () => {
    expect(parseAttributes('   ')).toEqual({});
  });

  it('should handle single attribute', () => {
    const result = parseAttributes('enabled=true');
    expect(result).toEqual({ enabled: 'true' });
  });
});

describe('parseBoundsString', () => {
  it('parses a normal bounds string into {x, y, width, height}', () => {
    expect(parseBoundsString('[68,255][333,312]')).toEqual({ x: 68, y: 255, width: 265, height: 57 });
  });

  it('returns undefined for an empty string', () => {
    expect(parseBoundsString('')).toBeUndefined();
  });

  it('returns undefined for garbage input', () => {
    expect(parseBoundsString('garbage')).toBeUndefined();
  });

  it('handles negative coordinates', () => {
    expect(parseBoundsString('[-10,0][20,40]')).toEqual({ x: -10, y: 0, width: 30, height: 40 });
  });

  it('handles zero-size bounds', () => {
    expect(parseBoundsString('[0,0][0,0]')).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('parseCsvHierarchy', () => {
  const SAMPLE_CSV = [
    'element_num,depth,bounds,attributes,parent_num',
    '1,0,"[0,0][393,852]","class=Application; resource-id=com.example.app",0',
    '2,1,"[0,0][393,852]","class=View; resource-id=main_container",1',
    '3,2,"[68,255][333,312]","accessibilityText=VILLAIN OS; resource-id=login_title; enabled=true",2',
    '4,2,"[55,492][346,551]","value=admin; text=admin; hintText=ENTER USERNAME; resource-id=login_username_field; enabled=true",2',
    '5,2,"[120,600][280,660]","accessibilityText=Sign In; resource-id=login_submit_button; class=Button; enabled=true",2',
  ].join('\n');

  it('should parse CSV with header into UIHierarchyNode tree', () => {
    const root = parseCsvHierarchy(SAMPLE_CSV);

    expect(root.role).toBe('Application');
    expect(root.id).toBe('com.example.app');
    expect(root.children).toHaveLength(1);

    const container = root.children[0];
    expect(container.id).toBe('main_container');
    expect(container.children).toHaveLength(3);
  });

  it('should extract accessibility labels from accessibilityText', () => {
    const root = parseCsvHierarchy(SAMPLE_CSV);
    const title = root.children[0].children[0];

    expect(title.accessibilityLabel).toBe('VILLAIN OS');
    expect(title.id).toBe('login_title');
  });

  it('should extract text and value attributes', () => {
    const root = parseCsvHierarchy(SAMPLE_CSV);
    const textField = root.children[0].children[1];

    expect(textField.text).toBe('admin');
    expect(textField.id).toBe('login_username_field');
  });

  it('should extract role from class attribute', () => {
    const root = parseCsvHierarchy(SAMPLE_CSV);
    const button = root.children[0].children[2];

    expect(button.role).toBe('Button');
    expect(button.id).toBe('login_submit_button');
    expect(button.accessibilityLabel).toBe('Sign In');
  });

  it('should return empty Application node for empty input', () => {
    const root = parseCsvHierarchy('');
    expect(root.role).toBe('Application');
    expect(root.children).toHaveLength(0);
  });

  it('should return empty Application node for header-only input', () => {
    const root = parseCsvHierarchy('element_num,depth,bounds,attributes,parent_num');
    expect(root.role).toBe('Application');
    expect(root.children).toHaveLength(0);
  });

  it('should handle CSV without header row', () => {
    const csvNoHeader = [
      '1,0,"[0,0][393,852]","class=View; resource-id=root",0',
      '2,1,"[10,10][100,100]","text=Hello; resource-id=greeting",1',
    ].join('\n');

    const root = parseCsvHierarchy(csvNoHeader);
    expect(root.id).toBe('root');
    expect(root.children).toHaveLength(1);
    expect(root.children[0].text).toBe('Hello');
  });

  it('should handle deeply nested hierarchies', () => {
    const deepCsv = [
      'element_num,depth,bounds,attributes,parent_num',
      '1,0,"[0,0][100,100]","class=View; resource-id=level0",0',
      '2,1,"[0,0][100,100]","class=View; resource-id=level1",1',
      '3,2,"[0,0][100,100]","class=View; resource-id=level2",2',
      '4,3,"[0,0][100,100]","text=Leaf; resource-id=level3",3',
    ].join('\n');

    const root = parseCsvHierarchy(deepCsv);
    expect(root.id).toBe('level0');
    expect(root.children[0].id).toBe('level1');
    expect(root.children[0].children[0].id).toBe('level2');
    expect(root.children[0].children[0].children[0].text).toBe('Leaf');
  });

  it('should parse root node with empty parent_num (real Maestro 2.4.0+ output)', () => {
    // Maestro's CLI emits an empty parent_num for depth-0 rows, e.g.:
    //   0,0,"[0,0][0,0]","",
    // Previously the isNaN(parentNum) guard rejected this row and the whole
    // tree came back empty.
    const rootlessParentCsv = [
      'element_num,depth,bounds,attributes,parent_num',
      '0,0,"[0,0][0,0]","",',
      '1,1,"[0,0][402,874]","accessibilityText=Experian Dev; enabled=true",0',
      '2,2,"[55,492][346,551]","resource-id=sign_in.button; class=Button",1',
    ].join('\n');

    const root = parseCsvHierarchy(rootlessParentCsv);
    expect(root.children).toHaveLength(1);
    expect(root.children[0].accessibilityLabel).toBe('Experian Dev');
    expect(root.children[0].children[0].id).toBe('sign_in.button');
  });

  it('should handle multiple children at the same depth', () => {
    const siblingsCsv = [
      'element_num,depth,bounds,attributes,parent_num',
      '1,0,"[0,0][400,800]","class=View; resource-id=parent",0',
      '2,1,"[0,0][200,400]","resource-id=child_a",1',
      '3,1,"[200,0][400,400]","resource-id=child_b",1',
      '4,1,"[0,400][400,800]","resource-id=child_c",1',
    ].join('\n');

    const root = parseCsvHierarchy(siblingsCsv);
    expect(root.children).toHaveLength(3);
    expect(root.children[0].id).toBe('child_a');
    expect(root.children[1].id).toBe('child_b');
    expect(root.children[2].id).toBe('child_c');
  });

  it('should populate bounds on parsed nodes from CSV', () => {
    const root = parseCsvHierarchy(SAMPLE_CSV);

    // Root node: "[0,0][393,852]" → {x:0, y:0, width:393, height:852}
    expect(root.bounds).toEqual({ x: 0, y: 0, width: 393, height: 852 });

    // login_title: "[68,255][333,312]" → {x:68, y:255, width:265, height:57}
    const title = root.children[0].children[0];
    expect(title.bounds).toEqual({ x: 68, y: 255, width: 265, height: 57 });

    // login_submit_button: "[120,600][280,660]" → {x:120, y:600, width:160, height:60}
    const button = root.children[0].children[2];
    expect(button.bounds).toEqual({ x: 120, y: 600, width: 160, height: 60 });
  });

  it('should leave bounds undefined for rows with empty bounds field', () => {
    const csvEmptyBounds = [
      'element_num,depth,bounds,attributes,parent_num',
      '0,0,"","",',
      '1,1,"[10,20][50,80]","resource-id=child",0',
    ].join('\n');

    const root = parseCsvHierarchy(csvEmptyBounds);
    expect(root.bounds).toBeUndefined();
    expect(root.children[0].bounds).toEqual({ x: 10, y: 20, width: 40, height: 60 });
  });
});
