# -*- coding: utf-8 -*-
"""
Test new architecture refactoring code

Test the following:
1. AnchorDetector - anchor detection
2. RegionBuilder - region building
3. TableAnchor - table anchor detection
4. ColumnBoundary - column boundary detection and overlap_ratio
5. InvoiceTemplate - template abstraction
"""

import sys
import os

# Add project path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + '/..')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Direct imports (assuming in current directory)
from models import Token, OCRDocument
from anchor_detector import AnchorDetector, AnchorCollection, detect_anchors
from region_builder import RegionBuilder, RegionCollection, build_regions
from table_anchor import TableAnchorDetector, TableAnchor, detect_table_anchors
from column_boundary import ColumnBoundary, ColumnBoundarySet, cell_owner, batch_cell_owner
from invoice_template import (InvoiceTemplateFactory, 
                               ElectronicCommonTemplate, 
                               ElectronicSpecialTemplate,
                               DigitalInvoiceTemplate,
                               get_template_for_invoice)


def create_mock_document():
    """
    创建模拟的 OCR 文档（用于测试）
    
    Returns:
        OCRDocument 对象
    """
    # 创建模拟的 tokens（使用中文模拟数据）
    tokens = [
        # 抬头区
        Token(text='电子发票', x0=0, y0=10, x1=100, y1=30),
        Token(text='发票代码', x0=0, y0=30, x1=100, y1=50),
        Token(text='12345678', x0=100, y0=30, x1=200, y1=50),
        
        # 购买方区
        Token(text='购买方信息', x0=0, y0=50, x1=100, y1=70),
        Token(text='名称：测试公司', x0=0, y0=70, x1=200, y1=90),
        Token(text='税号：1234567890', x0=0, y0=90, x1=200, y1=110),
        
        # 明细表头
        Token(text='项目名称', x0=0, y0=110, x1=100, y1=130),
        Token(text='规格型号', x0=100, y0=110, x1=200, y1=130),
        Token(text='单位', x0=200, y0=110, x1=250, y1=130),
        Token(text='数量', x0=250, y0=110, x1=300, y1=130),
        Token(text='单价', x0=300, y0=110, x1=350, y1=130),
        Token(text='金额', x0=350, y0=110, x1=400, y1=130),
        
        # 明细行
        Token(text='办公用品', x0=0, y0=130, x1=100, y1=150),
        Token(text='A4', x0=100, y0=130, x1=200, y1=150),
        Token(text='箱', x0=200, y0=130, x1=250, y1=150),
        Token(text='10', x0=250, y0=130, x1=300, y1=150),
        Token(text='50.00', x0=300, y0=130, x1=350, y1=150),
        Token(text='500.00', x0=350, y0=130, x1=400, y1=150),
        
        # 合计区
        Token(text='价税合计', x0=0, y0=150, x1=100, y1=170),
        Token(text='565.00', x0=100, y0=150, x1=200, y1=170),
        
        # 销售方区
        Token(text='销售方信息', x0=0, y0=170, x1=100, y1=190),
        Token(text='名称：销售公司', x0=0, y0=190, x1=200, y1=210),
        
        # 备注区
        Token(text='备注', x0=0, y0=210, x1=50, y1=230),
        Token(text='订单号：12345', x0=50, y0=210, x1=200, y1=230),
        
        # 页脚区
        Token(text='收款人', x0=0, y0=230, x1=50, y1=250),
        Token(text='复核人', x0=50, y0=230, x1=100, y1=250),
        Token(text='开票人', x0=100, y0=230, x1=150, y1=250),
    ]
    
    # 创建 OCRDocument
    doc = OCRDocument(
        raw=' '.join(t.text for t in tokens),
        bbox_tokens=tokens
    )
    
    return doc


def test_anchor_detector():
    """Test AnchorDetector"""
    print("\n=== Test AnchorDetector ===")
    
    # Create mock document
    doc = create_mock_document()
    
    # Detect anchors
    detector = AnchorDetector(doc)
    anchors = detector.detect()
    
    # Verify results
    assert anchors.buyer is not None, "Buyer anchor not detected"
    assert anchors.header is not None, "Header anchor not detected"
    assert anchors.summary is not None, "Summary anchor not detected"
    
    print(f"[PASS] Buyer anchor: {anchors.buyer.text}")
    print(f"[PASS] Header anchor: {anchors.header.text}")
    print(f"[PASS] Summary anchor: {anchors.summary.text}")
    
    if anchors.seller:
        print(f"[PASS] Seller anchor: {anchors.seller.text}")
    
    if anchors.remark:
        print(f"[PASS] Remark anchor: {anchors.remark.text}")
    
    print("AnchorDetector test passed!")
    return True


def test_region_builder():
    """Test RegionBuilder"""
    print("\n=== Test RegionBuilder ===")
    
    # Create mock document
    doc = create_mock_document()
    
    # Detect anchors
    detector = AnchorDetector(doc)
    anchors = detector.detect()
    
    # Build regions
    builder = RegionBuilder(doc, anchors)
    regions = builder.build()
    
    # Verify results
    assert regions.header is not None, "Header region not built"
    assert regions.buyer is not None, "Buyer region not built"
    assert regions.line_items is not None, "Line items region not built"
    
    print(f"[PASS] Header region: {len(regions.header.tokens)} tokens")
    print(f"[PASS] Buyer region: {len(regions.buyer.tokens)} tokens")
    print(f"[PASS] Line items region: {len(regions.line_items.tokens)} tokens")
    
    if regions.seller:
        print(f"[PASS] Seller region: {len(regions.seller.tokens)} tokens")
    
    if regions.remark:
        print(f"[PASS] Remark region: {len(regions.remark.tokens)} tokens")
    
    print("RegionBuilder test passed!")
    return True


def test_table_anchor():
    """Test TableAnchor"""
    print("\n=== Test TableAnchor ===")
    
    # Create mock document
    doc = create_mock_document()
    
    # Detect anchors
    detector = AnchorDetector(doc)
    anchors = detector.detect()
    
    # Detect table anchors
    table_detector = TableAnchorDetector(doc, anchors)
    table_anchors = table_detector.detect()
    
    # Verify results
    primary_anchor = table_anchors.get_primary_anchor()
    assert primary_anchor is not None, "Table anchor not detected"
    assert primary_anchor.is_valid(), "Table anchor is invalid"
    
    print(f"[PASS] Header bbox: {primary_anchor.header_bbox}")
    print(f"[PASS] Summary bbox: {primary_anchor.summary_bbox}")
    print(f"[PASS] Table bbox: {primary_anchor.table_bbox}")
    
    print("TableAnchor test passed!")
    return True


def test_column_boundary():
    """Test ColumnBoundary and overlap_ratio"""
    print("\n=== Test ColumnBoundary ===")
    
    # Create column boundary set
    columns = ColumnBoundarySet()
    columns.add_column(ColumnBoundary('xmmc', 0, 150))
    columns.add_column(ColumnBoundary('ggxh', 150, 220))
    columns.add_column(ColumnBoundary('dw', 220, 260))
    
    # Test token ownership
    token1 = Token(text='Office Supplies', x0=10, y0=130, x1=90, y1=150)
    col_name, orphans = cell_owner(token1, columns)
    assert col_name == 'xmmc', f"Token should belong to 'xmmc' column, but actually belongs to '{col_name}'"
    print(f"[PASS] Token '{token1.text}' correctly belongs to column '{col_name}'")
    
    # Test overlap_ratio too low
    token2 = Token(text='test', x0=300, y0=130, x1=320, y1=150)  # Not in any column's range
    col_name2, orphans2 = cell_owner(token2, columns)
    assert col_name2 is None, f"Token should not belong to any column, but actually belongs to '{col_name2}'"
    print(f"[PASS] Token '{token2.text}' correctly does not belong to any column (overlap_ratio too low)")
    
    # Test batch ownership
    tokens = [token1, token2]
    batch_result = batch_cell_owner(tokens, columns)
    assert len(batch_result['xmmc']) == 1, "Batch ownership result is incorrect"
    assert len(batch_result['orphan']) == 1, "Batch ownership result is incorrect"
    print(f"[PASS] Batch ownership test passed")
    
    print("ColumnBoundary test passed!")
    return True


def test_invoice_template():
    """Test InvoiceTemplate"""
    print("\n=== Test InvoiceTemplate ===")
    
    # Test template factory
    template = InvoiceTemplateFactory.create_template('ElectronicCommon')
    assert template is not None, "Template creation failed"
    print(f"[PASS] Created template: {template.get_template_name()}")
    
    # Test getting column boundaries
    columns = template.get_column_boundaries(table_width=600, table_x0=0)
    assert len(columns.columns) > 0, "Column boundaries获取失败"
    print(f"[PASS] Got column boundaries: {len(columns.columns)} columns")
    
    # Test template detection
    doc_text = "Electronic Invoice Invoice Code 12345678"
    detected_template = InvoiceTemplateFactory.detect_best_template(doc_text)
    assert detected_template is not None, "Template detection failed"
    print(f"[PASS] Detected best template: {detected_template.get_template_name()}")
    
    # Test all templates
    all_templates = InvoiceTemplateFactory.get_all_templates()
    assert len(all_templates) > 0, "Getting all templates failed"
    print(f"[PASS] Got all templates: {len(all_templates)} templates")
    
    print("InvoiceTemplate test passed!")
    return True


def test_integration():
    """Test integration: all modules work together"""
    print("\n=== Test Integration ===")
    
    # Create mock document
    doc = create_mock_document()
    
    # Step 1: Detect anchors
    anchors = detect_anchors(doc)
    assert anchors.buyer is not None, "Anchor detection failed"
    print("[PASS] Step 1: Anchor detection completed")
    
    # Step 2: Build regions
    regions = build_regions(doc, anchors)
    assert regions.buyer is not None, "Region building failed"
    print("[PASS] Step 2: Region building completed")
    
    # Step 3: Detect table anchors
    table_anchors = detect_table_anchors(doc, anchors)
    assert table_anchors.get_primary_anchor() is not None, "Table anchor detection failed"
    print("[PASS] Step 3: Table anchor detection completed")
    
    # Step 4: Get template
    template = get_template_for_invoice(doc)
    assert template is not None, "Template获取失败"
    print(f"[PASS] Step 4: Got template '{template.get_template_name()}'")
    
    # Step 5: Get column boundaries
    table_bbox = table_anchors.get_primary_anchor().table_bbox
    if table_bbox:
        table_width = table_bbox[2] - table_bbox[0]
        table_x0 = table_bbox[0]
        columns = template.get_column_boundaries(table_width, table_x0)
        assert len(columns.columns) > 0, "Column boundaries获取失败"
        print(f"[PASS] Step 5: Got column boundaries ({len(columns.columns)} columns)")
    
    print("\nAll integration tests passed!")
    return True


def main():
    """Main test function"""
    print("Starting to test new architecture refactoring code...")
    
    try:
        # Run all tests
        test_anchor_detector()
        test_region_builder()
        test_table_anchor()
        test_column_boundary()
        test_invoice_template()
        test_integration()
        
        print("\n" + "="*50)
        print("All tests passed! New architecture refactoring code works normally.")
        print("="*50)
        
        return 0
        
    except AssertionError as e:
        print(f"\nTest failed: {e}")
        import traceback
        traceback.print_exc()
        return 1
        
    except Exception as e:
        print(f"\nTest error: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == '__main__':
    sys.exit(main())
