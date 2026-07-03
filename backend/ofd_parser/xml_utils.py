"""
OFD XML 工具函数
命名空间处理、元素查找、颜色/边界/路径解析、资源加载
"""
import re
import xml.etree.ElementTree as ET


def _strip_ofd_ns(xml_str):
    """去掉 OFD 命名空间前缀"""
    xml_str = re.sub(r'\s+xmlns(?::\w+)?="[^"]*"', '', xml_str)
    xml_str = re.sub(r'<(\w+):', r'<', xml_str)
    xml_str = re.sub(r'</(\w+):', r'</', xml_str)
    return xml_str


def _parse_ofd_color(color_str):
    """解析 OFD 颜色值，返回 PIL 可用的颜色字符串"""
    if not color_str:
        return None
    color_str = color_str.strip()

    if re.match(r'^#[0-9A-Fa-f]{6}$', color_str):
        return color_str

    m = re.match(r'rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)', color_str)
    if m:
        return f'#{int(m.group(1)):02x}{int(m.group(2)):02x}{int(m.group(3)):02x}'

    parts = re.split(r'[\s,]+', color_str.strip())
    if len(parts) >= 3:
        try:
            r, g, b = int(parts[0]), int(parts[1]), int(parts[2])
            if 0 <= r <= 255 and 0 <= g <= 255 and 0 <= b <= 255:
                return f'#{r:02x}{g:02x}{b:02x}'
        except ValueError:
            pass

    named_colors = {
        'red': '#ff0000', 'blue': '#0000ff', 'green': '#008000',
        'black': '#000000', 'white': '#ffffff',
    }
    return named_colors.get(color_str.lower(), None)


def _parse_boundary(boundary_str, unit_to_mm):
    """解析 OFD Boundary 字符串，返回 (x, y, w, h) 单位 mm"""
    if not boundary_str:
        return 0, 0, 0, 0
    parts = re.split(r'[\s,]+', boundary_str.strip())
    if len(parts) >= 4:
        try:
            x, y, w, h = float(parts[0]), float(parts[1]), float(parts[2]), float(parts[3])
            return x * unit_to_mm, y * unit_to_mm, w * unit_to_mm, h * unit_to_mm
        except ValueError:
            return 0, 0, 0, 0
    return 0, 0, 0, 0


def _parse_path_data(d_str, ox, oy, unit_to_mm, scale):
    """解析 OFD Path 的 d 属性，提取 stroke/fill 和坐标点"""
    if not d_str:
        return None

    result = {'stroke': False, 'fill': False, 'points': [], 'color': None, 'line_width': 1}

    # 检测 stroke/fill 模式
    d_upper = d_str.upper()
    if 'S' in d_upper and 'F' not in d_upper:
        result['stroke'] = True
    if 'F' in d_upper and 'S' not in d_upper:
        result['fill'] = True
    if 'S' in d_upper and 'F' in d_upper:
        result['stroke'] = True
        result['fill'] = True

    # 提取坐标点
    coords = re.findall(r'([-\d.]+)\s+([-\d.]+)', d_str)
    for cx, cy in coords:
        x = (float(cx) + ox) * unit_to_mm * scale
        y = (float(cy) + oy) * unit_to_mm * scale
        result['points'].append((x, y))

    return result


def load_ofd_resources(zf, all_names):
    """加载 OFD 压缩包内的多媒体资源映射"""
    resources = {}
    res_files = [n for n in all_names
                 if n.lower().endswith('res.xml') or n.lower().endswith('resources.xml')]

    for res_file in res_files:
        try:
            content = zf.read(res_file).decode('utf-8', errors='ignore')
            content_clean = _strip_ofd_ns(content)
            root = ET.fromstring(content_clean)

            for elem in root.iter():
                tag = elem.tag.split('}')[-1] if '}' in elem.tag else elem.tag
                if tag == 'MultiMedia':
                    rid = elem.get('ID', elem.get('id', ''))
                    file_path = None
                    for child in elem:
                        ctag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
                        if ctag in ('File', 'MediaFile') and child.text:
                            file_path = child.text.strip()
                            break

                    if not file_path:
                        continue

                    base_dir = '/'.join(res_file.split('/')[:-1])
                    full_path = f"{base_dir}/{file_path}" if base_dir else file_path
                    full_path = full_path.replace('\\', '/')

                    if full_path in all_names:
                        resources[rid] = full_path
                    else:
                        for prefix in ['Doc_0/res', 'Doc_0/Res', 'res', 'Res']:
                            alt = f"{prefix}/{file_path}"
                            if alt in all_names:
                                resources[rid] = alt
                                break
        except Exception as e:
            print(f"OFD资源文件解析失败 {res_file}: {e}")

    # 补充扫描
    for name in all_names:
        nl = name.lower()
        if ('/res/' in nl or '/Res/' in nl) and nl.endswith(('.png', '.jpg', '.jpeg', '.bmp')):
            fname = name.split('/')[-1]
            m = re.search(r'(\d+)', fname)
            if m and m.group(1) not in resources:
                resources[m.group(1)] = name
            if fname not in resources:
                resources[fname] = name

    return resources
