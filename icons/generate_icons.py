import base64
import os

# Простая SVG иконка в base64 для разных размеров
svg_template = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}">
  <rect width="{size}" height="{size}" rx="{radius}" fill="#6366f1"/>
  <rect x="{margin}" y="{margin}" width="{inner}" height="{inner}" rx="{inner_radius}" fill="rgba(255,255,255,0.85)"/>
  <circle cx="{center}" cy="{center}" r="{head}" fill="#6366f1"/>
  <line x1="{center}" y1="{antenna_start}" x2="{center}" y2="{antenna_end}" stroke="#6366f1" stroke-width="{stroke}"/>
  <circle cx="{center}" cy="{antenna_end}" r="{dot}" fill="#ef4444"/>
</svg>'''

os.makedirs('/workspace/apps/protalk_page_ai/icons', exist_ok=True)

for size in [16, 48, 128]:
    margin = size // 6
    inner = size - 2 * margin
    inner_radius = size // 5
    center = size // 2
    head = size // 6
    antenna_start = center - head
    antenna_end = center - head - size // 8
    stroke = max(2, size // 20)
    dot = max(2, size // 12)
    radius = size // 8
    
    svg = svg_template.format(
        size=size, margin=margin, inner=inner, inner_radius=inner_radius,
        center=center, head=head, antenna_start=antenna_start, 
        antenna_end=antenna_end, stroke=stroke, dot=dot, radius=radius
    )
    
    # Сохраняем как SVG (Chrome поддерживает SVG иконки)
    with open(f'/workspace/apps/protalk_page_ai/icons/icon{size}.svg', 'w') as f:
        f.write(svg)
    
    # Также создаем PNG через простой подход - используем встроенный в Chrome
    print(f"Created icon{size}.svg")

print("SVG icons created")
